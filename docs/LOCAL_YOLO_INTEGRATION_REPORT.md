# DEFENX local vision integration

This handoff replaces the earlier separate Local YOLO and local face prototypes.

The dashboard uses one local scanner and one loopback Python service. It captures each live dashboard camera frame once and submits a single request. If both controls are on, that request runs YOLO and face detection/recognition against the same frame under one inference lock. If Local YOLO is off while Local Face ID remains on, the service runs only face scanning. Browser AI pauses the corresponding work while local scanning is active.

The service loads `yolov8n.pt` once per process, selects CUDA when PyTorch reports it available, and retries on CPU if GPU inference fails. It never opens a webcam; camera ownership and lifecycle remain in the dashboard. Run one Uvicorn worker so the model is not loaded by multiple processes.

The local API exposes `/health`, `/vision-detect`, compatibility endpoints `/detect` and `/face-detect`, `/alerts`, and face gallery/enrollment endpoints. Person and vehicle alerts are throttled in the dashboard. Unknown faces remain UNKNOWN; uncertain matches are not labeled as enrolled people. Face names and templates stay on the scanning PC. The authenticated phone/laptop sync relays sanitized labels, boxes, and recognized/unknown/unverified status only.

See [LOCAL_VISION.md](LOCAL_VISION.md) for Windows install and run steps. The branch has not been merged or deployed. Local hardware, real camera behavior, GPU inference, and two physical device sync still require operator testing.
