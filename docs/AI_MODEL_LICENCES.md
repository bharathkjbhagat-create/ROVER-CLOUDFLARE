# DEFENX browser AI model notices

## YOLOX-Nano object detector

- Architecture and upstream weights: YOLOX-Nano, Megvii-BaseDetection/YOLOX.
- Upstream project: https://github.com/Megvii-BaseDetection/YOLOX
- Model artifact: `yolox_nano.onnx`
- Browser distribution: https://huggingface.co/skillsafe-ai/yolox-nano
- Model SHA-256: `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`
- Upstream model licence: Apache License 2.0.
- Attribution: Copyright (c) 2021-2022 Megvii Inc.

The model is downloaded directly to the browser, SHA-256 checked before use, and cached locally by the browser. Camera frames and inference tensors are processed on the user's device; they are not sent to the model host or Cloudflare.

## ONNX Runtime Web

- Project: https://github.com/microsoft/onnxruntime
- Package: `onnxruntime-web@1.31.1`
- Licence: MIT.

The runtime is loaded from a version-pinned jsDelivr URL. The YOLOX model is a separate Apache-2.0 artifact; the runtime licence does not change the model's licence.
