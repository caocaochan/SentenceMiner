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
    bind_toggle_key = "yes",
    toggle_key = "Ctrl+Shift+m",
    overlay_enabled = "no",
    overlay_exe_path = "",
    overlay_yomitan_extension_path = "",
    overlay_hide_mpv_subtitles = "yes",
    overlay_hide_mpv_osc = "yes",
    overlay_font_family = "",
    overlay_font_size_px = 42,
    overlay_bottom_offset_pct = 14,
    overlay_max_width_pct = 86,
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
}

options.read_options(opts, "sentenceminer")

local AUDIO_NORMALIZATION_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11"

local state = {
    enabled = false,
    open_browser_when_ready = false,
    session_id = nil,
    session_generation = 0,
    last_subtitle_key = nil,
    last_subtitle_track_key = nil,
    capture = nil,
    last_capture_fetch = 0,
    helper_ready = false,
    helper_starting = false,
    helper_waiters = {},
    overlay_pid = nil,
    previous_sub_visibility = nil,
    overlay_subtitles_hidden = false,
    overlay_osc_hidden = false,
    last_overlay_start_attempt = 0,
    last_overlay_process_probe = 0,
}

local JSON_NULL = {}

math.randomseed(os.time())

local function is_truthy(value)
    local normalized = tostring(value or ""):lower()
    return normalized == "yes" or normalized == "true" or normalized == "1" or normalized == "on"
end

local function is_sentence_miner_enabled()
    return state.enabled
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

local function is_path_like(path)
    if not path or path == "" then
        return false
    end

    return path:match("^[.~]") ~= nil or path:match("[/\\]") ~= nil or path:match("^%a:") ~= nil
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

local function trim_output(value)
    if not value or value == "" then
        return nil
    end

    return tostring(value):gsub("%s+$", "")
end

local function url_encode_component(value)
    return tostring(value):gsub("([^%w%-_%.~])", function(char)
        return string.format("%%%02X", string.byte(char))
    end)
end

local function helper_error_from_result(result)
    local decoded_stdout = parse_json_output(result and result.stdout or nil)
    if decoded_stdout and type(decoded_stdout) == "table" and decoded_stdout.message then
        return tostring(decoded_stdout.message)
    end

    local decoded_stderr = parse_json_output(result and result.stderr or nil)
    if decoded_stderr and type(decoded_stderr) == "table" and decoded_stderr.message then
        return tostring(decoded_stderr.message)
    end

    local stderr = trim_output(result and result.stderr or nil)
    if stderr then
        stderr = stderr:gsub("^curl:%s*%(%d+%)%s*", "")
        return stderr
    end

    local error_string = trim_output(result and result.error_string or nil)
    if error_string then
        return error_string
    end

    return nil
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

    local args = {
        is_windows() and "curl.exe" or "curl",
        "-sS",
        "--fail-with-body",
        "-X",
        method,
        "--max-time",
        tostring(timeout_seconds),
        "-H",
        "Accept: application/json",
        url,
    }

    if body_path then
        table.insert(args, "-H")
        table.insert(args, "Content-Type: application/json")
        table.insert(args, "--data-binary")
        table.insert(args, "@" .. body_path)
    end

    local result = utils.subprocess({
        args = args,
        cancellable = false,
        max_size = 1024 * 1024 * 8,
        playback_only = false,
    })

    if body_path then
        cleanup_file(body_path)
    end

    if result.status ~= 0 then
        return nil, helper_error_from_result(result) or ("helper request failed with status " .. tostring(result.status))
    end

    local stdout = result.stdout or ""
    if stdout:match("^%s*null%s*$") then
        return JSON_NULL, nil
    end

    local decoded = parse_json_output(stdout)
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

local function normalize_optional_string(value)
    if value == nil then
        return nil
    end

    local normalized = tostring(value)
    if normalized == "" then
        return nil
    end

    return normalized
end

local function current_subtitle_track_payload()
    local payload = {
        sessionId = state.session_id,
        filePath = mp.get_property("path", "") or "",
        kind = "none",
        externalFilePath = nil,
        trackId = nil,
        ffIndex = nil,
        codec = nil,
        title = nil,
        lang = nil,
    }

    local track_list = read_json_property("track-list")
    if type(track_list) ~= "table" then
        return payload
    end

    for _, track in ipairs(track_list) do
        if type(track) == "table" and track.type == "sub" and track.selected then
            local main_selection = tonumber(track["main-selection"])
            if main_selection == nil or main_selection == 0 then
                payload.trackId = track.id ~= nil and tonumber(track.id) or nil
                payload.ffIndex = track["ff-index"] ~= nil and tonumber(track["ff-index"]) or nil
                payload.codec = normalize_optional_string(track.codec)
                payload.title = normalize_optional_string(track.title)
                payload.lang = normalize_optional_string(track.lang)

                local external_filename = normalize_optional_string(track["external-filename"])
                if track.external and external_filename then
                    payload.kind = "external"
                    payload.externalFilePath = expand_mpv_path(external_filename)
                else
                    payload.kind = "embedded"
                end

                return payload
            end
        end
    end

    return payload
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

local function subtitle_track_key(payload)
    return table.concat({
        payload.sessionId or "",
        payload.filePath or "",
        payload.kind or "",
        payload.externalFilePath or "",
        tostring(payload.trackId),
        tostring(payload.ffIndex),
        payload.codec or "",
        payload.title or "",
        payload.lang or "",
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

local function resolve_overlay_exe_path()
    if not is_truthy(opts.overlay_enabled) then
        return nil, "overlay is disabled"
    end

    local configured = opts.overlay_exe_path
    local script_dir = get_script_dir()
    local candidates = {}

    local function add_candidate(path)
        if path and path ~= "" then
            table.insert(candidates, expand_mpv_path(path))
        end
    end

    if configured ~= nil and configured ~= "" then
        add_candidate(configured)
        if not configured:lower():match("%.exe$") then
            add_candidate(utils.join_path(configured, "SentenceMinerOverlay.exe"))
        end

        if script_dir and script_dir ~= "" and not is_absolute_path(configured) then
            local relative = utils.join_path(script_dir, configured)
            add_candidate(relative)
            if not configured:lower():match("%.exe$") then
                add_candidate(utils.join_path(relative, "SentenceMinerOverlay.exe"))
            end

            local parent = parent_dir(script_dir)
            if parent then
                local parent_relative = utils.join_path(parent, configured)
                add_candidate(parent_relative)
                if not configured:lower():match("%.exe$") then
                    add_candidate(utils.join_path(parent_relative, "SentenceMinerOverlay.exe"))
                end
            end
        end
    elseif script_dir and script_dir ~= "" then
        add_candidate(utils.join_path(utils.join_path(script_dir, "sentenceminer-overlay"), "SentenceMinerOverlay.exe"))
        local parent = parent_dir(script_dir)
        if parent then
            add_candidate(utils.join_path(utils.join_path(parent, "sentenceminer-overlay"), "SentenceMinerOverlay.exe"))
            add_candidate(utils.join_path(utils.join_path(utils.join_path(utils.join_path(utils.join_path(parent, "dist"), "SentenceMiner"), "scripts"), "sentenceminer-overlay"), "SentenceMinerOverlay.exe"))
            add_candidate(utils.join_path(utils.join_path(utils.join_path(utils.join_path(utils.join_path(utils.join_path(parent, "dist"), "build"), "overlay"), "packaged"), "SentenceMinerOverlay-win32-x64"), "SentenceMinerOverlay.exe"))
        end
    end

    for _, candidate in ipairs(candidates) do
        if file_exists(candidate) then
            return candidate, nil
        end
    end

    return nil, "could not find SentenceMinerOverlay.exe; copy sentenceminer-overlay next to sentenceminer.lua or set overlay_exe_path"
end

local function resolve_overlay_yomitan_extension_path()
    local configured = trim_output(opts.overlay_yomitan_extension_path)
    if not configured then
        return nil
    end

    local expanded = expand_mpv_path(configured)
    if is_absolute_path(expanded) then
        return expanded
    end

    local script_dir = get_script_dir()
    if script_dir and script_dir ~= "" then
        return utils.join_path(script_dir, expanded)
    end

    return expanded
end

local function resolve_ffmpeg_path()
    local configured = trim_output(opts.ffmpeg_path) or "ffmpeg"
    local script_dir = get_script_dir()

    local function bundled_candidates()
        local candidates = {}

        local function add_candidate(candidate)
            if candidate and candidate ~= "" then
                table.insert(candidates, expand_mpv_path(candidate))
            end
        end

        if script_dir and script_dir ~= "" then
            add_candidate(utils.join_path(utils.join_path(script_dir, "sentenceminer-helper"), "ffmpeg.exe"))
            add_candidate(utils.join_path(script_dir, "ffmpeg.exe"))

            local parent = parent_dir(script_dir)
            if parent then
                add_candidate(utils.join_path(utils.join_path(utils.join_path(parent, "scripts"), "sentenceminer-helper"), "ffmpeg.exe"))
            end
        end

        return candidates
    end

    if configured:lower() == "ffmpeg" or configured:lower() == "ffmpeg.exe" then
        for _, candidate in ipairs(bundled_candidates()) do
            if file_exists(candidate) then
                return candidate, nil
            end
        end

        return configured, nil
    end

    if not is_path_like(configured) then
        return configured, nil
    end

    local candidates = {}

    local function add_candidate(candidate)
        if candidate and candidate ~= "" then
            table.insert(candidates, expand_mpv_path(candidate))
        end
    end

    add_candidate(configured)
    if not configured:lower():match("ffmpeg%.exe$") then
        add_candidate(utils.join_path(configured, "ffmpeg.exe"))
    end

    if script_dir and script_dir ~= "" and not is_absolute_path(configured) then
        local relative = utils.join_path(script_dir, configured)
        add_candidate(relative)
        if not configured:lower():match("ffmpeg%.exe$") then
            add_candidate(utils.join_path(relative, "ffmpeg.exe"))
        end

        local parent = parent_dir(script_dir)
        if parent then
            local parent_relative = utils.join_path(parent, configured)
            add_candidate(parent_relative)
            if not configured:lower():match("ffmpeg%.exe$") then
                add_candidate(utils.join_path(parent_relative, "ffmpeg.exe"))
            end
        end
    end

    for _, candidate in ipairs(candidates) do
        if file_exists(candidate) then
            return candidate, nil
        end
    end

    return nil, string.format(
        "ffmpeg_path='%s' did not resolve to ffmpeg.exe; set it to ffmpeg.exe, a folder containing ffmpeg.exe, or leave it as ffmpeg to auto-discover the bundled copy",
        configured
    )
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
    local mpv_pid = utils.getpid()
    local result = utils.subprocess({
        args = {
            "powershell",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            string.format(
                "Start-Process -FilePath '%s' -ArgumentList '--parent-pid %s' -WorkingDirectory '%s' -WindowStyle Hidden",
                powershell_escape(helper_exe_path),
                powershell_escape(tostring(mpv_pid)),
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

local function hide_mpv_subtitles_for_overlay()
    if not is_truthy(opts.overlay_hide_mpv_subtitles) or state.overlay_subtitles_hidden then
        return
    end

    state.previous_sub_visibility = mp.get_property("sub-visibility")
    state.overlay_subtitles_hidden = true
    mp.set_property("sub-visibility", "no")
end

local function restore_mpv_subtitles_after_overlay()
    if not state.overlay_subtitles_hidden then
        return
    end

    if state.previous_sub_visibility ~= nil then
        mp.set_property("sub-visibility", state.previous_sub_visibility)
    end

    state.previous_sub_visibility = nil
    state.overlay_subtitles_hidden = false
end

local function hide_mpv_osc_for_overlay()
    if not is_truthy(opts.overlay_hide_mpv_osc) or state.overlay_osc_hidden then
        return
    end

    local ok, err = pcall(mp.commandv, "script-message", "osc-visibility", "never", "no-osd")
    if not ok then
        msg.warn("could not hide mpv OSC for SentenceMiner overlay: " .. tostring(err))
        return
    end

    state.overlay_osc_hidden = true
end

local function restore_mpv_osc_after_overlay()
    if not state.overlay_osc_hidden then
        return
    end

    local ok, err = pcall(mp.commandv, "script-message", "osc-visibility", "auto", "no-osd")
    if not ok then
        msg.warn("could not restore mpv OSC after SentenceMiner overlay: " .. tostring(err))
    end

    state.overlay_osc_hidden = false
end

local function spawn_overlay_process()
    if not is_windows() then
        return nil, "overlay is currently implemented only on Windows"
    end

    local overlay_exe_path, resolve_err = resolve_overlay_exe_path()
    if not overlay_exe_path then
        return nil, resolve_err
    end

    local working_dir = parent_dir(overlay_exe_path) or get_script_dir() or "."
    local argument_parts = {
        "'--'",
        string.format("'%s'", powershell_escape(opts.helper_url)),
        string.format("'%s'", powershell_escape(tostring(utils.getpid()))),
    }
    local yomitan_extension_path = resolve_overlay_yomitan_extension_path()
    if yomitan_extension_path then
        table.insert(argument_parts, string.format("'%s'", powershell_escape(yomitan_extension_path)))
    end

    local command = string.format(
        "$p = Start-Process -FilePath '%s' -ArgumentList @(%s) -WorkingDirectory '%s' -WindowStyle Hidden -PassThru; $p.Id",
        powershell_escape(overlay_exe_path),
        table.concat(argument_parts, ","),
        powershell_escape(working_dir)
    )

    local result = utils.subprocess({
        args = {
            "powershell",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            command,
        },
        cancellable = false,
        playback_only = false,
        max_size = 1024 * 1024,
    })

    if result.status ~= 0 then
        return nil, result.error_string or result.stderr or "failed to start overlay"
    end

    local pid = tonumber(trim_output(result.stdout) or "")
    if not pid then
        return nil, "overlay started but did not report a process id"
    end

    return pid, nil
end

local function is_overlay_process_alive()
    if not state.overlay_pid or not is_windows() then
        return state.overlay_pid ~= nil
    end

    local result = utils.subprocess({
        args = {
            "powershell",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            string.format(
                "if (Get-Process -Id %s -ErrorAction SilentlyContinue) { 'yes' }",
                powershell_escape(tostring(state.overlay_pid))
            ),
        },
        cancellable = false,
        playback_only = false,
        max_size = 1024 * 16,
    })

    return result.status == 0 and trim_output(result.stdout) == "yes"
end

local function ensure_overlay_running()
    if not is_truthy(opts.overlay_enabled) then
        return
    end

    if state.overlay_pid ~= nil then
        local now = mp.get_time()
        if (now - state.last_overlay_process_probe) < 2 then
            return
        end

        state.last_overlay_process_probe = now
        if is_overlay_process_alive() then
            return
        end

        msg.warn("SentenceMiner overlay process exited; attempting restart")
        restore_mpv_subtitles_after_overlay()
        restore_mpv_osc_after_overlay()
        state.overlay_pid = nil
    end

    local now = mp.get_time()
    if (now - state.last_overlay_start_attempt) < 2 then
        return
    end
    state.last_overlay_start_attempt = now

    local pid, err = spawn_overlay_process()
    if not pid then
        msg.warn("could not start SentenceMiner overlay: " .. tostring(err))
        mp.osd_message("SentenceMiner overlay: " .. tostring(err), 4)
        return
    end

    state.overlay_pid = pid
    hide_mpv_subtitles_for_overlay()
    hide_mpv_osc_for_overlay()
end

local function stop_overlay_process()
    restore_mpv_subtitles_after_overlay()
    restore_mpv_osc_after_overlay()

    if not state.overlay_pid then
        return
    end

    if is_windows() then
        local result = utils.subprocess({
            args = {
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                string.format("Stop-Process -Id %s -ErrorAction SilentlyContinue", powershell_escape(tostring(state.overlay_pid))),
            },
            cancellable = false,
            playback_only = false,
            max_size = 1024 * 1024,
        })
        if result.status ~= 0 then
            msg.warn("could not stop SentenceMiner overlay: " .. tostring(result.stderr or result.error_string or "unknown error"))
        end
    end

    state.overlay_pid = nil
end

local function open_helper_site()
    if not is_windows() then
        return nil, "automatic browser opening is currently implemented only on Windows"
    end

    local url = trim_trailing_slash(opts.helper_url or "")
    if url == "" then
        return nil, "helper_url is empty"
    end

    local result = utils.subprocess({
        args = {
            "powershell",
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            string.format("Start-Process '%s'", powershell_escape(url)),
        },
        cancellable = false,
        playback_only = false,
        max_size = 1024 * 1024,
    })

    if result.status ~= 0 then
        return nil, result.error_string or result.stderr or "failed to open browser"
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
    if not is_sentence_miner_enabled() then
        on_ready(false, "SentenceMiner is disabled")
        return
    end

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
        if not is_sentence_miner_enabled() then
            if poll_ready then
                local _, shutdown_err = helper_request("POST", "/api/runtime/shutdown", nil, 1000)
                if shutdown_err then
                    msg.warn("could not request helper shutdown: " .. tostring(shutdown_err))
                end
                state.helper_ready = false
            end

            state.helper_starting = false
            flush_helper_waiters(false, "SentenceMiner is disabled")
            return
        end

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
    if not is_sentence_miner_enabled() then
        return
    end

    local path = mp.get_property("path", "")
    if path == "" then
        return
    end

    state.session_generation = state.session_generation + 1
    local generation = state.session_generation

    state.session_id = string.format("%d-%d", os.time(), math.random(100000, 999999))
    state.last_subtitle_key = nil
    state.last_subtitle_track_key = nil

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
            subtitleTrack = current_subtitle_track_payload(),
        })

        if request_err then
            state.helper_ready = false
            state.session_id = nil
            state.last_subtitle_key = nil
            msg.warn("could not start helper session: " .. tostring(request_err))
            mp.osd_message("SentenceMiner: could not start helper session", 4)
            return
        end

        state.last_subtitle_track_key = subtitle_track_key(current_subtitle_track_payload())

        if state.open_browser_when_ready then
            local _, open_err = open_helper_site()
            if open_err then
                msg.warn("could not open helper site: " .. tostring(open_err))
            else
                state.open_browser_when_ready = false
            end
        end

        ensure_overlay_running()
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
    state.last_subtitle_track_key = nil
end

local function shutdown_helper()
    if not state.helper_ready and not state.helper_starting then
        return
    end

    local _, err = helper_request("POST", "/api/runtime/shutdown", nil, 1000)
    if err then
        msg.warn("could not request helper shutdown: " .. tostring(err))
    end

    state.helper_ready = false
end

local function sync_subtitle_state()
    if not is_sentence_miner_enabled() then
        return
    end

    if not state.session_id then
        return
    end

    if not state.helper_ready then
        ensure_helper_ready(function(ok, err)
            if not ok and err then
                msg.warn("could not reconnect helper for subtitle sync: " .. tostring(err))
            end
        end)
        return
    end

    local payload = current_subtitle_payload()
    local key = subtitle_key(payload)
    if key == state.last_subtitle_key then
        return
    end

    local _, err = helper_request("POST", "/api/subtitle-event", payload)
    if err then
        state.helper_ready = false
        msg.warn("could not post subtitle event: " .. tostring(err))
        return
    end

    state.last_subtitle_key = key
end

local function sync_subtitle_track_state()
    if not is_sentence_miner_enabled() then
        return
    end

    if not state.session_id or not state.helper_ready then
        return
    end

    local payload = current_subtitle_track_payload()
    local key = subtitle_track_key(payload)
    if key == state.last_subtitle_track_key then
        return
    end

    local _, err = helper_request("POST", "/api/subtitle-track", payload)
    if err then
        state.helper_ready = false
        msg.warn("could not post subtitle track update: " .. tostring(err))
        return
    end

    state.last_subtitle_track_key = key
end

local function sync_player_command()
    if not is_sentence_miner_enabled() then
        return
    end

    if not state.session_id or not state.helper_ready then
        return
    end

    local response, err = helper_request(
        "GET",
        "/api/player-command?sessionId=" .. url_encode_component(state.session_id),
        nil,
        1000
    )
    if err then
        state.helper_ready = false
        msg.warn("could not poll helper player command: " .. tostring(err))
        return
    end

    if response ~= JSON_NULL and response.type == "seek" and response.startMs ~= nil then
        mp.commandv("seek", format_seconds((tonumber(response.startMs) or 0) / 1000), "absolute+exact")
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
    local ffmpeg_path, ffmpeg_err = resolve_ffmpeg_path()
    if not ffmpeg_path then
        error(ffmpeg_err)
    end
    local args = {
        ffmpeg_path,
        "-y",
        "-ss",
        format_seconds(clip_start_ms / 1000),
        "-i",
        payload.filePath,
        "-t",
        format_seconds(duration_ms / 1000),
        "-vn",
        "-af",
        AUDIO_NORMALIZATION_FILTER,
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
    local ffmpeg_path, ffmpeg_err = resolve_ffmpeg_path()
    if not ffmpeg_path then
        error(ffmpeg_err)
    end

    mp.commandv("screenshot-to-file", raw_path, screenshot_mode)

    local args = {
        ffmpeg_path,
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
    if not is_sentence_miner_enabled() then
        mp.osd_message("SentenceMiner: disabled", 2)
        return
    end

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

local function set_sentence_miner_enabled(enabled)
    state.enabled = enabled

    if enabled then
        state.open_browser_when_ready = true
        mp.osd_message("SentenceMiner: enabled", 2)
        if mp.get_property("path", "") ~= "" then
            start_session()
        end
        return
    end

    state.open_browser_when_ready = false
    stop_session()
    stop_overlay_process()
    shutdown_helper()
    mp.osd_message("SentenceMiner: disabled", 2)
end

local function toggle_sentence_miner_enabled()
    local next_enabled = not is_sentence_miner_enabled()
    set_sentence_miner_enabled(next_enabled)
end

mp.register_event("file-loaded", start_session)
mp.register_event("end-file", stop_session)
mp.register_event("shutdown", function()
    stop_session()
    stop_overlay_process()
    shutdown_helper()
end)
mp.add_periodic_timer(0.2, function()
    sync_subtitle_track_state()
    sync_subtitle_state()
    sync_player_command()
    if state.session_id and state.helper_ready then
        ensure_overlay_running()
    end
end)

mp.register_script_message("mine", mine_current)
mp.register_script_message("toggle-enabled", toggle_sentence_miner_enabled)

if is_truthy(opts.bind_default_key) then
    mp.add_forced_key_binding(opts.default_key, "sentenceminer-mine", mine_current)
end

if is_truthy(opts.bind_toggle_key) then
    mp.add_forced_key_binding(opts.toggle_key, "sentenceminer-toggle-enabled", toggle_sentence_miner_enabled)
end
