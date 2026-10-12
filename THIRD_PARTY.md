# Third-party components and their licences

This project's own code is MIT (see `LICENSE`). It depends on the following. Check each one's current
terms yourself before a commercial release; the notes below are a starting point, not legal advice.

| Component | Used for | Licence |
|---|---|---|
| **InsightFace pretrained models** (`buffalo_l` detector + recogniser) | Face matching for selfie search | **Non-commercial research use only** (per the InsightFace project). The InsightFace Python *code* is MIT, but the downloaded models are not free for commercial use. For a commercial product, license the models from the InsightFace authors or swap in a model you may use commercially (the engine is isolated in `FaceEngine` in `indexer.py`). |
| onnxruntime | Runs the face models | MIT |
| OpenCV | Image/video handling | Apache-2.0 |
| FastAPI, Starlette, Uvicorn, Pydantic | API server | MIT / BSD |
| NumPy, Pillow | Image maths | BSD-style / HPND |
| boto3 | Talks to Cloudflare R2 (S3 API) | Apache-2.0 |
| pyftpdlib | Camera FTP receiver | MIT |
| pica (`static/vendor/pica.min.js`) | High-quality image resizing in the browser | MIT |
| MediaPipe Tasks Vision (loaded from a CDN at run time) | Face detection in the selfie camera | Apache-2.0 |
| FFmpeg (called as a program, not bundled) | Video and boomerang processing | LGPL/GPL depending on your build |
| Adobe Lightroom Classic (not included) | Optional auto-edit lane | Proprietary. You need your own Adobe licence. |
| Cloudflare Workers, R2, D1, Tunnel | Hosting | Cloudflare's terms and pricing |

Use only photos, faces and logos you have the right to process and publish. Selfie search processes biometric
data: get consent from guests and follow your local privacy law.
