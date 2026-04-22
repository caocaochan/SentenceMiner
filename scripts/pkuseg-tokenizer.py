import json
import sys
import traceback

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

try:
    import pkuseg

    SEGMENTER = pkuseg.pkuseg(model_name="default", user_dict="default")
except Exception:
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)


def write_payload(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def tokenize_payload(payload):
    texts = payload.get("texts")
    if not isinstance(texts, list):
        return {"error": "Expected texts to be an array."}

    tokenizations = []
    for text in texts:
        if not isinstance(text, str):
            return {"error": "Expected every text value to be a string."}
        tokenizations.append({"segments": SEGMENTER.cut(text)})

    return {"tokenizations": tokenizations}


for line in sys.stdin:
    try:
        request = json.loads(line)
        write_payload(tokenize_payload(request))
    except Exception as error:
        write_payload({"error": str(error)})
