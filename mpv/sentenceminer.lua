local mp = require("mp")
local msg = require("mp.msg")
local options = require("mp.options")
local utils = require("mp.utils")

local opts = {
    helper_url = "http://127.0.0.1:8766",
    helper_timeout_ms = 5000,
    helper_auto_start = "yes",
    helper_exe_path = "",
    helper_start_timeout_ms = 15000,
    ffmpeg_path = "ffmpeg",
    temp_dir = "",
    capture_audio = "yes",
    capture_image = "yes",
    bind_default_key = "no",
    default_key = "Ctrl+m",
    server_host = "127.0.0.1",
    server_port = 8766,
    anki_url = "http://127.0.0.1:8765",
    anki_api_key = "",
    anki_deck = "Anime",
    anki_note_type = "Sentence",
    anki_extra_query = "",
    anki_field_subtitle = "Sentence",
    anki_field_audio = "Audio",
    anki_field_image = "Picture",
    anki_field_source = "Source",
    anki_field_time = "Time",
    anki_field_filename = "Filename",
    anki_filename_template = "{basename}-{startMs}-{kind}.{ext}",
    capture_audio_pre_padding_ms = 250,
    capture_audio_post_padding_ms = 250,
    capture_audio_format = "mp3",
    capture_audio_codec = "libmp3lame",
    capture_audio_bitrate = "128k",
    capture_image_format = "jpg",
    capture_image_quality = 2,
    capture_image_max_width = 1600,
    capture_image_max_height = 900,
    capture_image_include_subtitles = "yes",
    transcript_history_limit = 250,
}

options.read_options(opts, "sentenceminer")

local state = {
    session_id = nil,
    session_generation = 0,
    last_subtitle_key = nil,
    capture = nil,
    last_capture_fetch = 0,
    helper_ready = false,
    helper_starting = false,
    helper_waiters = {},
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

local function parent_dir(path)
    if not path or path == "" then
        return nil
    end

    local normalized = path:gsub("[/\\]+$", "")
    local trimmed = normalized:gsub("[/\\][^/\\]+$", "")
    if trimmed == normalized then
        return nil
    end

    return trimmed
end

local function is_absolute_path(path)
    if not path or path == "" then
        return false
    end

    if path:match("^%a:[/\\]") then
        return true
    end

    if path:match("^[/\\][/\\]") then
        return true
    end

    return path:sub(1, 1) == "/"
end

local function expand_mpv_path(path)
    if not path or path == "" or not path:match("^~~") then
        return path
    end

    local ok, expanded = pcall(mp.command_native, {
        name = "expand-path",
        args = { path },
    })
    if ok and type(expanded) == "string" and expanded ~= "" then
        return expanded
    end

    return path
end

local function get_script_dir()
    local script_dir = expand_mpv_path(mp.get_script_directory())
    if script_dir and script_dir ~= "" then
        return script_dir
    end

    if type(debug) == "table" and type(debug.getinfo) == "function" then
        local info = debug.getinfo(1, "S")
        local source = info and info.source or nil
        if type(source) == "string" and source:sub(1, 1) == "@" then
            return parent_dir(expand_mpv_path(source:sub(2)))
        end
    end

    return nil
end

local function stem(path)
    local name = basename(path)
    return name:gsub("%.[^.]+$", "")
end

local function file_exists(path)
    if not path or path == "" then
        return false
    end

    local handle = io.open(expand_mpv_path(path), "rb")
    if not handle then
        return false
    end

    handle:close()
    return true
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

local function helper_request(method, endpoint, payload, timeout_ms)
    local url = join_url(opts.helper_url, endpoint)
    local timeout_seconds = math.max(1, math.floor((tonumber(timeout_ms) or tonumber(opts.helper_timeout_ms) or 5000) / 1000))
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
            "$ErrorActionPreference='Stop'",
            "$ProgressPreference='SilentlyContinue'",
            string.format("$uri='%s'", powershell_escape(url)),
            string.format("$requestArgs = @{ Method = '%s'; Uri = $uri; TimeoutSec = %d; ErrorAction = 'Stop' }", method, timeout_seconds),
        }

        if body_path then
            table.insert(
                script,
                string.format(
                    "$requestArgs['ContentType'] = 'application/json'; $requestArgs['Body'] = Get-Content -Raw -LiteralPath '%s'",
                    powershell_escape(body_path)
                )
            )
        end

        table.insert(script, [[
try {
    $resp = Invoke-RestMethod @requestArgs
    $resp | ConvertTo-Json -Depth 16 -Compress
} catch {
    $statusCode = $null
    if ($_.Exception -and $_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }

    $message = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $details = $_.ErrorDetails.Message
        try {
            $parsed = $details | ConvertFrom-Json
            if ($parsed -and $parsed.message) {
                $message = [string]$parsed.message
            }
        } catch {
        }

        if (-not $message) {
            $message = $details
        }
    }

    if (-not $message -and $_.Exception) {
        $message = $_.Exception.Message
    }

    if (-not $message) {
        $message = 'Unknown helper request failure.'
    }

    if ($statusCode) {
        $message = "HTTP ${statusCode}: $message"
    }

    [Console]::Error.WriteLine($message)
    exit 1
}
]])
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

local function helper_port_hint()
    local port = tostring(opts.helper_url or ""):match(":(%d+)")
    if not port then
        return ""
    end

    return " Check whether another process is already using port " .. port .. "."
end

local function flush_helper_waiters(ok, err)
    local waiters = state.helper_waiters
    state.helper_waiters = {}

    for _, waiter in ipairs(waiters) do
        waiter(ok, err)
    end
end

local function resolve_helper_exe_path()
    if opts.helper_exe_path ~= nil and opts.helper_exe_path ~= "" then
        local configured = opts.helper_exe_path
        local script_dir = get_script_dir()
        local candidates = {}

        local function add_candidate(path)
            if path and path ~= "" then
                table.insert(candidates, expand_mpv_path(path))
            end
        end

        add_candidate(configured)
        if not configured:lower():match("%.exe$") then
            add_candidate(utils.join_path(configured, "SentenceMinerHelper.exe"))
        end

        if script_dir and script_dir ~= "" and not is_absolute_path(configured) then
            local relative = utils.join_path(script_dir, configured)
            add_candidate(relative)
            if not configured:lower():match("%.exe$") then
                add_candidate(utils.join_path(relative, "SentenceMinerHelper.exe"))
            end

            local parent = parent_dir(script_dir)
            if parent then
                local parent_relative = utils.join_path(parent, configured)
                add_candidate(parent_relative)
                if not configured:lower():match("%.exe$") then
                    add_candidate(utils.join_path(parent_relative, "SentenceMinerHelper.exe"))
                end
            end
        end

        for _, candidate in ipairs(candidates) do
            if file_exists(candidate) then
                return candidate
            end
        end

        return nil, string.format(
            "helper_exe_path='%s' did not resolve to SentenceMinerHelper.exe; set it to the .exe path, the helper folder, or leave it empty for auto-discovery",
            configured
        )
    end

    local script_dir = get_script_dir()
    local candidates = {}
    if script_dir and script_dir ~= "" then
        table.insert(candidates, utils.join_path(utils.join_path(script_dir, "sentenceminer-helper"), "SentenceMinerHelper.exe"))
        table.insert(candidates, utils.join_path(script_dir, "SentenceMinerHelper.exe"))

        local parent = parent_dir(script_dir)
        if parent then
            table.insert(candidates, utils.join_path(utils.join_path(parent, "sentenceminer-helper"), "SentenceMinerHelper.exe"))
        end
    end

    for _, candidate in ipairs(candidates) do
        if file_exists(candidate) then
            return candidate
        end
    end

    return nil, "could not find SentenceMinerHelper.exe; copy sentenceminer-helper next to sentenceminer.lua or set helper_exe_path"
end

local function spawn_helper_process()
    if not is_windows() then
        return nil, "helper auto-start is currently implemented only on Windows"
    end

    local helper_exe_path, resolve_err = resolve_helper_exe_path()
    if not helper_exe_path then
        return nil, resolve_err
    end

    local working_dir = parent_dir(helper_exe_path) or get_script_dir() or "."
    local result = utils.subprocess({
        args = {
            "powershell",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            string.format(
                "Start-Process -FilePath '%s' -WorkingDirectory '%s' -WindowStyle Hidden",
                powershell_escape(helper_exe_path),
                powershell_escape(working_dir)
            ),
        },
        cancellable = false,
        playback_only = false,
        max_size = 1024 * 1024,
    })

    if result.status ~= 0 then
        return nil, result.error_string or result.stderr or "failed to start helper"
    end

    return true, nil
end

local function probe_helper()
    local response, err = helper_request("GET", "/api/state", nil, 1000)
    if response and response.success == true and response.state ~= nil and response.config ~= nil then
        state.helper_ready = true
        return true, nil
    end

    state.helper_ready = false
    if response then
        return false, "helper URL responded, but it was not a SentenceMiner helper." .. helper_port_hint()
    end

    return false, err
end

local function ensure_helper_ready(on_ready)
    local ready, ready_err = probe_helper()
    if ready then
        on_ready(true, nil)
        return
    end

    if ready_err and tostring(ready_err):find("not a SentenceMiner helper", 1, true) then
        on_ready(false, ready_err)
        return
    end

    if not is_truthy(opts.helper_auto_start) then
        on_ready(false, "helper is not running and helper_auto_start is disabled")
        return
    end

    table.insert(state.helper_waiters, on_ready)
    if state.helper_starting then
        return
    end

    state.helper_starting = true
    local started, start_err = spawn_helper_process()
    if not started then
        state.helper_starting = false
        flush_helper_waiters(false, "could not auto-start helper: " .. tostring(start_err))
        return
    end

    local deadline = mp.get_time() + ((tonumber(opts.helper_start_timeout_ms) or 15000) / 1000)
    local function poll()
        local poll_ready, poll_err = probe_helper()
        if poll_ready then
            state.helper_starting = false
            flush_helper_waiters(true, nil)
            return
        end

        if mp.get_time() >= deadline then
            state.helper_starting = false
            flush_helper_waiters(
                false,
                "helper did not become ready in time." .. helper_port_hint() .. " Last error: " .. tostring(poll_err)
            )
            return
        end

        mp.add_timeout(0.35, poll)
    end

    mp.add_timeout(0.35, poll)
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

    state.session_generation = state.session_generation + 1
    local generation = state.session_generation

    state.session_id = string.format("%d-%d", os.time(), math.random(100000, 999999))
    state.last_subtitle_key = nil

    ensure_helper_ready(function(ok, err)
        if generation ~= state.session_generation or not state.session_id then
            return
        end

        if not ok then
            state.session_id = nil
            state.last_subtitle_key = nil
            mp.osd_message("SentenceMiner: " .. tostring(err), 5)
            msg.warn("could not prepare helper session: " .. tostring(err))
            return
        end

        local _, request_err = helper_request("POST", "/api/session", {
            action = "start",
            sessionId = state.session_id,
            filePath = path,
            durationMs = read_time_property_ms("duration/full"),
            playbackTimeMs = read_time_property_ms("playback-time/full"),
        })

        if request_err then
            state.helper_ready = false
            state.session_id = nil
            state.last_subtitle_key = nil
            msg.warn("could not start helper session: " .. tostring(request_err))
            mp.osd_message("SentenceMiner: could not start helper session", 4)
        end
    end)
end

local function stop_session()
    state.session_generation = state.session_generation + 1

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
    if not state.session_id or not state.helper_ready then
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
        state.helper_ready = false
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
        state.helper_ready = false
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
