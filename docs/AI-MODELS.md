# DEFENX AI model notes

## Object detection

- Primary detector: YOLOv8n exported to ONNX, executed in the browser with ONNX Runtime Web using the WebAssembly backend.
- Model file: [yolov8n.onnx](https://huggingface.co/unileon-robotics/YOLO8-ONNX/resolve/main/yolov8n.onnx) (about 12.8 MB).
- Model input: `images`, float32 `[1, 3, 480, 640]`; output: `output0`, float32 `[1, 84, 6300]`.
- Camera pixels are preprocessed and inferred locally in the browser. No camera frames are uploaded by this detector.
- COCO-SSD remains the automatic fallback if ONNX Runtime, the model download, or WebAssembly initialization fails.
- The existing face-recognition pipeline remains separate and unchanged; YOLO is object detection, not face identity recognition.

## License

The selected YOLOv8n ONNX weights are derived from Ultralytics YOLOv8 and are marked **AGPL-3.0** by the model publisher. This is free to use under that license, but it is not an unrestricted permissive license. Review and comply with the AGPL-3.0 obligations before distributing or operating a modified network-accessible application. If those obligations are unsuitable, replace the weights with a model whose license is compatible with the project's distribution and deployment.

Model card and tensor dimensions: https://huggingface.co/unileon-robotics/YOLO8-ONNX
ONNX Runtime Web documentation: https://onnxruntime.ai/docs/tutorials/web/
