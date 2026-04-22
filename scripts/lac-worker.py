import json
import sys
import traceback


def write_message(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    from LAC import LAC

    lac = LAC(mode="seg")
except Exception:
    write_message({
        "id": 0,
        "error": "Unable to import and initialize Baidu LAC. Install it with `pip install LAC` for the Python used by SENTENCEMINER_LAC_PYTHON.\n"
        + traceback.format_exc(),
    })
    sys.exit(1)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    request = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        texts = request.get("texts")
        if not isinstance(request_id, int) or not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
            raise ValueError("Expected JSON object with integer id and string-array texts.")

        segments = lac.run(texts)
        if not isinstance(segments, list):
            raise ValueError("LAC returned a non-list response.")

        write_message({
            "id": request_id,
            "segments": segments,
        })
    except Exception:
        write_message({
            "id": request.get("id") if isinstance(request, dict) else None,
            "error": traceback.format_exc(),
        })
