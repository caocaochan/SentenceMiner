local mp = require("mp")
local msg = require("mp.msg")
local options = require("mp.options")
local utils = require("mp.utils")

local opts = {
    helper_url = "http://127.0.0.1:8766",
    helper_timeout_ms = 5000,
    ffmpeg_path = "ffmpeg",
    temp_dir = "",
    capture_audio = "yes",
    capture_image = "yes",
    bind_default_key = "no",
    default_key = "Ctrl+m",
}

options.read_options(opts, "sentenceminer")

local state = {
    session_id = nil,
    last_subtitle_key = nil,
    capture = nil,
    last_capture_fetch = 0,
}

math.randomseed(os.time())

local function is_truthy(value)
    local normalized = tostring(value or ""):lower()
    return normalized == "yes" or normalized == "true" or normalized == "1" or normalized == "on"
end

local function is_windows()
    return package.config:sub(1, 1) == "\\"
end

local function trim_trailing_slash(value)
    return (value:gsub("/+$", ""))
end

local function join_url(base, path)
    return trim_trailing_slash(base) .. path
end

local function get_temp_dir()
    if opts.temp_dir ~= nil and opts.temp_dir ~= "" then
        return opts.temp_dir
    end

    return os.getenv("TEMP") or os.getenv("TMPDIR") or "/tmp"
end

local function sanitize_filename(value)
    local sanitized = value
        :gsub('[<>:"/\\|%?%*%z\1-\31]', "-")
        :gsub("%s+", " ")
        :gsub("^%s+", "")
        :gsub("%s+$", "")
        :gsub(" ", "-")

    if sanitized == "" then
        return "untitled"
    end

    return sanitized
end

local function basename(path)
    if not path or path == "" then
        return "untitled"
    end

    local normalized = path:gsub("\\", "/")
    return normalized:match("([^/]+)$") or normalized
end

local function stem(path)
    local name = basename(path)
    return name:gsub("%.[^.]+$", "")
end

local function write_file(path, content)
    local handle, err = io.open(path, "wb")
    if not handle then
        return nil, err
    end

    handle:write(content)
    handle:close()
    return true
end

local function read_json_property(name)
    local value = mp.get_property_native(name)
    if value == nil then
        return nil
    end
    return value
end

local function read_time_property_ms(name)
    local value = read_json_property(name)
    if value == nil then
        return nil
    end
    return math.floor((tonumber(value) or 0) * 1000 + 0.5)
end

local function format_seconds(value)
    return string.format("%.3f", value)
end

local function make_temp_path(kind, extension)
    local dir = get_temp_dir()
    local media_name = sanitize_filename(stem(mp.get_property("path", "")))
    local filename = string.format(
        "sentenceminer-%s-%s-%d.%s",
        media_name,
        kind,
        math.random(100000, 999999),
        extension:gsub("^%.", "")
    )

    return utils.join_path(dir, filename)
end

local function cleanup_file(path)
    if not path or path == "" then
        return
    end
    os.remove(path)
end

local function parse_json_output(output)
    if not output or output == "" then
        return nil
    end
    return utils.parse_json(output)
end

local function powershell_escape(value)
    return tostring(value):gsub("'", "''")
end

local function helper_request(method, endpoint, payload)
    local url = join_url(opts.helper_url, endpoint)
    local timeout_seconds = math.max(1, math.floor((tonumber(opts.helper_timeout_ms) or 5000) / 1000))
    local body_path = nil

    if payload ~= nil then
        body_path = make_temp_path("request", "json")
        local ok, err = write_file(body_path, utils.format_json(payload))
        if not ok then
            return nil, "failed to write request body: " .. tostring(err)
        end
    end

    local result
    if is_windows() then
        local script = {
            "$ProgressPreference='SilentlyContinue'",
            string.format("$uri='%s'", powershell_escape(url)),
            string.format("$resp = Invoke-RestMethod -Method %s -Uri $uri -TimeoutSec %d", method, timeout_seconds),
        }

        if body_path then
            script[3] = string.format(
                "$resp = Invoke-RestMethod -Method %s -Uri $uri -TimeoutSec %d -ContentType 'application/json' -Body (Get-Content -Raw -LiteralPath '%s')",
                method,
                timeout_seconds,
                powershell_escape(body_path)
            )
        end

        table.insert(script, "$resp | ConvertTo-Json -Depth 16 -Compress")
        result = utils.subprocess({
            args = { "powershell", "-NoProfile", "-Command", table.concat(script, "; ") },
            cancellable = false,
            max_size = 1024 * 1024 * 8,
            playback_only = false,
        })
    else
        local args = {
            "curl",
            "-sS",
            "-X",
            method,
            "--max-time",
            tostring(timeout_seconds),
            url,
        }

        if body_path then
            table.insert(args, "-H")
            table.insert(args, "Content-Type: application/json")
            table.insert(args, "--data-binary")
            table.insert(args, "@" .. body_path)
        end

        result = utils.subprocess({
            args = args,
            cancellable = false,
            max_size = 1024 * 1024 * 8,
            playback_only = false,
        })
    end

    if body_path then
        cleanup_file(body_path)
    end

    if result.status ~= 0 then
        return nil, result.error_string or result.stderr or ("helper request failed with status " .. tostring(result.status))
    end

    local decoded = parse_json_output(result.stdout)
    if not decoded then
        return nil, "helper returned invalid JSON"
    end

    return decoded, nil
end

local function is_local_media(path)
    if not path or path == "" then
        return false
    end

    return not path:match("^[%a][%w+.-]*://")
end

local function current_subtitle_payload()
    local path = mp.get_property("path", "")
    return {
        sessionId = state.session_id,
        text = mp.get_property("sub-text", "") or "",
        startMs = read_time_property_ms("sub-start/full"),
        endMs = read_time_property_ms("sub-end/full"),
        playbackTimeMs = read_time_property_ms("playback-time/full"),
        filePath = path,
    }
end

local function subtitle_key(payload)
    return table.concat({
        payload.sessionId or "",
        payload.filePath or "",
        tostring(payload.startMs),
        tostring(payload.endMs),
        payload.text or "",
    }, "::")
end

local function fetch_capture_settings()
    local now = os.time()
    if state.capture and (now - state.last_capture_fetch) < 10 then
        return state.capture
    end

    local response, err = helper_request("GET", "/api/state", nil)
    if not response then
        if not state.capture then
            msg.warn("could not fetch helper capture settings: " .. tostring(err))
        end
        return state.capture or {
            audioPrePaddingMs = 250,
            audioPostPaddingMs = 250,
            audioFormat = "mp3",
            audioCodec = "libmp3lame",
            audioBitrate = "128k",
            imageFormat = "jpg",
            imageQuality = 2,
            imageMaxWidth = 1600,
            imageMaxHeight = 900,
            imageIncludeSubtitles = true,
        }
    end

    state.capture = response.config and response.config.capture or state.capture
    state.last_capture_fetch = now
    return state.capture
end

local function start_session()
    local path = mp.get_property("path", "")
    if path == "" then
        return
    end

    state.session_id = string.format("%d-%d", os.time(), math.random(100000, 999999))
    state.last_subtitle_key = nil

    local _, err = helper_request("POST", "/api/session", {
        action = "start",
        sessionId = state.session_id,
        filePath = path,
        durationMs = read_time_property_ms("duration/full"),
        playbackTimeMs = read_time_property_ms("playback-time/full"),
    })

    if err then
        msg.warn("could not start helper session: " .. tostring(err))
    end
end

local function stop_session()
    if not state.session_id then
        return
    end

    local _, err = helper_request("POST", "/api/session", {
        action = "stop",
        sessionId = state.session_id,
    })

    if err then
        msg.warn("could not stop helper session: " .. tostring(err))
    end

    state.session_id = nil
    state.last_subtitle_key = nil
end

local function sync_subtitle_state()
    if not state.session_id then
        return
    end

    local payload = current_subtitle_payload()
    local key = subtitle_key(payload)
    if key == state.last_subtitle_key then
        return
    end

    state.last_subtitle_key = key
    local _, err = helper_request("POST", "/api/subtitle-event", payload)
    if err then
        msg.warn("could not post subtitle event: " .. tostring(err))
    end
end

local function run_ffmpeg(args, description)
    local result = utils.subprocess({
        args = args,
        cancellable = false,
        max_size = 1024 * 1024 * 4,
        playback_only = false,
    })

    if result.status ~= 0 then
        error(string.format("%s failed: %s", description, result.stderr or result.error_string or "unknown ffmpeg error"))
    end
end

local function capture_audio(payload, capture)
    if not is_truthy(opts.capture_audio) then
        return nil
    end

    if not is_local_media(payload.filePath) then
        error("audio capture requires a local media file")
    end

    if payload.startMs == nil or payload.endMs == nil then
        error("audio capture requires subtitle timing")
    end

    local prepad = tonumber(capture.audioPrePaddingMs) or 0
    local postpad = tonumber(capture.audioPostPaddingMs) or 0
    local duration_ms = payload.endMs - payload.startMs + prepad + postpad
    if duration_ms <= 0 then
        error("audio duration was not positive")
    end

    local clip_start_ms = math.max(0, payload.startMs - prepad)
    local media_duration_ms = read_time_property_ms("duration/full")
    if media_duration_ms ~= nil then
        duration_ms = math.min(duration_ms, math.max(0, media_duration_ms - clip_start_ms))
    end

    local extension = tostring(capture.audioFormat or "mp3")
    local output_path = make_temp_path("audio", extension)
    local args = {
        opts.ffmpeg_path,
        "-y",
        "-ss",
        format_seconds(clip_start_ms / 1000),
        "-i",
        payload.filePath,
        "-t",
        format_seconds(duration_ms / 1000),
        "-vn",
        "-acodec",
        tostring(capture.audioCodec or "libmp3lame"),
        "-b:a",
        tostring(capture.audioBitrate or "128k"),
        output_path,
    }

    run_ffmpeg(args, "audio extraction")
    return output_path
end

local function capture_image(capture)
    if not is_truthy(opts.capture_image) then
        return nil
    end

    local raw_path = make_temp_path("shot-raw", "png")
    local output_extension = tostring(capture.imageFormat or "jpg")
    local output_path = make_temp_path("shot", output_extension)
    local screenshot_mode = capture.imageIncludeSubtitles == false and "video" or "subtitles"

    mp.commandv("screenshot-to-file", raw_path, screenshot_mode)

    local args = {
        opts.ffmpeg_path,
        "-y",
        "-i",
        raw_path,
    }

    local max_width = tonumber(capture.imageMaxWidth) or 0
    local max_height = tonumber(capture.imageMaxHeight) or 0
    if max_width > 0 and max_height > 0 then
        table.insert(args, "-vf")
        table.insert(args, string.format("scale=%d:%d:force_original_aspect_ratio=decrease", max_width, max_height))
    end

    local format_name = output_extension:lower()
    if format_name == "jpg" or format_name == "jpeg" or format_name == "webp" then
        table.insert(args, "-q:v")
        table.insert(args, tostring(capture.imageQuality or 2))
    end

    table.insert(args, output_path)
    run_ffmpeg(args, "image processing")
    cleanup_file(raw_path)
    return output_path
end

local function mine_current()
    if not state.session_id then
        mp.osd_message("SentenceMiner: no active session", 2)
        return
    end

    local payload = current_subtitle_payload()
    if payload.text == nil or payload.text == "" then
        mp.osd_message("SentenceMiner: no current subtitle", 2)
        return
    end

    local capture = fetch_capture_settings()
    local audio_path = nil
    local image_path = nil

    local ok, err = pcall(function()
        audio_path = capture_audio(payload, capture)
        image_path = capture_image(capture)
    end)

    if not ok then
        cleanup_file(audio_path)
        cleanup_file(image_path)
        mp.osd_message("SentenceMiner: " .. tostring(err), 4)
        return
    end

    payload.audioPath = audio_path
    payload.screenshotPath = image_path

    local response, request_err = helper_request("POST", "/api/mine", payload)
    cleanup_file(audio_path)
    cleanup_file(image_path)

    if not response then
        mp.osd_message("SentenceMiner: " .. tostring(request_err), 4)
        return
    end

    local message = response.message or "Updated Anki note"
    if response.noteId then
        message = string.format("%s (note %s)", message, tostring(response.noteId))
    end
    mp.osd_message("SentenceMiner: " .. message, 3)
end

mp.register_event("file-loaded", start_session)
mp.register_event("end-file", stop_session)
mp.register_event("shutdown", stop_session)
mp.add_periodic_timer(0.2, sync_subtitle_state)

mp.register_script_message("mine", mine_current)

if is_truthy(opts.bind_default_key) then
    mp.add_forced_key_binding(opts.default_key, "sentenceminer-mine", mine_current)
end
