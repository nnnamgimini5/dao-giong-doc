# Siêu engine Pikafish (bản WebAssembly cho Cờ Tướng Đạo Pro)

- Engine: **Pikafish**, https://github.com/official-pikafish/Pikafish, commit `8d8db92` (16/11/2026). Giấy phép GPLv3, xem `COPYING-Pikafish.txt`.
- Mạng NNUE: `pikafish.nnue` bản master-net, chia làm 2 phần `pikafish.nnue.0` và `pikafish.nnue.1`, app tải về rồi ghép lại. SHA-256 của file ghép: `071aefc0730e124876a97609a4a75624d62fa5d3155858c9646a1a8272e9e458`.
- Phần sửa để chạy trong trình duyệt: `pikafish-wasm.patch` (sửa `Makefile`, `uci.cpp`) và file mới `wasm_io.cpp` (đặt vào `src/`).
- `pfw.js`: luồng chạy engine, nhận lệnh UCI từ app.

## Cách build lại

```bash
git clone https://github.com/official-pikafish/Pikafish && cd Pikafish && git checkout 8d8db92
git apply pikafish-wasm.patch && cp wasm_io.cpp src/
source emsdk/emsdk_env.sh   # Emscripten 7.0.0
cd src && make -j8 build ARCH=wasm32 COMP=clang CXX=em++ clangmajorversion=20 RTLIB=compiler-rt \
  EXTRALDFLAGS="-sPROXY_TO_PTHREAD -sEXIT_RUNTIME=0 -sENVIRONMENT=web,worker -sEXPORTED_FUNCTIONS=_main,_uci_command -sEXPORTED_RUNTIME_METHODS=ccall,FS -sPTHREAD_POOL_SIZE=4 -sMODULARIZE=1 -sEXPORT_NAME=Pikafish -sMAXIMUM_MEMORY=2GB"
```

Engine cần trang được cách ly bảo mật (COOP/COEP), đã khai báo trong `vercel.json` ở gốc repo.
