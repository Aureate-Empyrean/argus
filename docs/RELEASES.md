# Argus releases and provenance

## Version control history

Development from 0.1.0 (commit `bbdfece`) to 0.2.0 was not committed as it happened. Intermediate versions have no history and none was reconstructed. Commits and tags carry their true creation date, which is after deployment.

## 0.2.0

| | |
| --- | --- |
| Tag | `v0.2.0` (annotated, tag object `3a85bbef2683890b5dadd4885e644aa401b84e52`) |
| Baseline commit | `8076b70eab08da851af1f864c5f6acb0743aa7b4`, created 2026-11-09 after deployment |
| Deployed image | `sha256:7666e6d3ce699e0928b6508c9f50258a4806f2d3b0bff8c75c25399ca6efe3ad` |
| Image config | `sha256:14a8bb2a5fb58440c40e09c51271def2a91fd8e1f156b00720a336e7050d1f32` |
| Image built | 2026-11-09T08:46:33.112983701Z |
| Deployed | Exodus, 2026-11-09. The running container's image was read back on 2026-11-09 and matches the digest above |

### What has been demonstrated

Checked on 2026-11-09 from a clean clone of the tagged commit, against the image archive saved at release time.

- Of 26 non-compiled files in the image's `/app`, 14 are byte-identical to the tag and 12 differ only in line endings.
- The image was rebuilt with `deploy/Dockerfile`. Every file outside `/app` that is not a compiled `.pyc` is identical. Entrypoint, environment and user are the same.
- The unit suite passes on the clone: 46 passed.

### What has not been demonstrated

The build is **not reproducible to the digest**. Two rebuilds gave two different digests, sharing 5 of 12 layers with the deployed image.

- The deployed image was built from a Windows working tree, so 12 text files have CRLF line endings there and LF here.
- The deployed image holds 8 extra `.pyc` files under `/app`, copied from local test runs because `.dockerignore` does not exclude `__pycache__`. A clean checkout has none.
- 849 `.pyc` files from installed packages differ between builds, because they embed build-time data.
- The commit was made after the image was built. It records matching content, not the build's actual input.

### Face models

`models/*.onnx` are not stored in Git. They are required at build time (`COPY models`) and at run time, at `/app/models` unless `ARGUS_MODELS` overrides it. Fetch and verify them before building a clean checkout:

```bash
python scripts/fetch_models.py
```

| File | Source | Licence | SHA-256 |
| --- | --- | --- | --- |
| `face_detection_yunet_2023mar.onnx` | OpenCV Model Zoo, commit `f12e127` | MIT | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec.onnx` | OpenCV Model Zoo, commit `ba91a3b` | Apache-2.0 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

They are unmodified upstream downloads: the checksums equal the upstream Git LFS records, and files fetched with the script match the deployed image. Argus's own embeddings live in its database, never in these files, so they hold no personal data from this installation. The upstream SFace network was trained by its authors on public face datasets; that is unrelated to this installation. The fixture `tests/fixtures/astronaut.png` is a public NASA portrait.

## Conventions

Create the tag before deploying and build from a clean checkout of it. Record the commit and image digest in the deployment record. Do not move a published tag.
