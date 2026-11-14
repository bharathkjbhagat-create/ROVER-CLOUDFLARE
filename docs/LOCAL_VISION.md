# DEFENX local AI service (Windows)

The dashboard remains the sole camera owner. It captures one frame per cycle and sends that frame to this single local Python process. This service does not open a webcam or start a background camera loop. YOLO and face recognition share the same serialized frame pipeline; face-only mode does not call YOLO.

## Install

From the repository root in Windows Command Prompt:

```bat
py -3.11 -m venv .venv-local-ai
.venv-local-ai\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements-local-ai.txt
```

Copy the project's existing `yolov8n.pt` into the repository root, or set `DEFENX_YOLO_MODEL` to its full path. For face recognition, provide the OpenCV Zoo YuNet and SFace ONNX models and set `DEFENX_YUNET_MODEL` and `DEFENX_SFACE_MODEL` to their paths. They are not downloaded automatically. The local gallery is written to `data/face_gallery.json`; keep it on the scanning PC.

Set `DEFENX_AI_ALLOWED_ORIGINS` to comma-separated exact origins for the dashboard and local development site. The default includes the DEFENX Workers site and localhost:5000. The service binds only to loopback.

## Run

```bat
set DEFENX_AI_ALLOWED_ORIGINS=https://defenx.bindukjagadish.workers.dev,http://127.0.0.1:5000,http://localhost:5000
python -m uvicorn tools.local_ai_server.ai_server:app --host 127.0.0.1 --port 8000 --workers 1
```

Use one worker: each process loads its own model. CUDA is selected automatically when PyTorch reports an available GPU; inference falls back to CPU if CUDA inference fails. To force CPU, set `DEFENX_AI_DEVICE=cpu`. Check `http://127.0.0.1:8000/health`. Use the dashboard's existing LOCAL YOLO and LOCAL FACE ID controls. The YOLO control can be off while local face scanning stays on.

## API

- `GET /health`
- `POST /vision-detect` multipart fields `image`, `include_objects`, `include_faces`
- `POST /detect` combined compatibility endpoint
- `POST /face-detect` face-only compatibility endpoint
- `GET /alerts`, `GET /faces`, `POST /faces/enroll`, `DELETE /faces/{name}`

Only sanitized detection labels/boxes and face status (recognized/unknown/unverified) are relayed through the authenticated live device channel. Recognized names and face templates stay on the scanning PC. Do not bind this server to a public interface or expose port 8000.
