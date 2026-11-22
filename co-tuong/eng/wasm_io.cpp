// Cầu nối lệnh UCI cho bản WebAssembly: JS gọi uci_command(), vòng UCI đọc qua wasm_getline().
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
namespace {
std::mutex              qm;
std::condition_variable qcv;
std::deque<std::string> q;
}
extern "C" EMSCRIPTEN_KEEPALIVE void uci_command(const char* c) {
    {
        std::lock_guard<std::mutex> l(qm);
        q.emplace_back(c);
    }
    qcv.notify_one();
}
bool wasm_getline(std::string& s) {
    std::unique_lock<std::mutex> l(qm);
    qcv.wait(l, [] { return !q.empty(); });
    s = q.front();
    q.pop_front();
    return true;
}
#endif
