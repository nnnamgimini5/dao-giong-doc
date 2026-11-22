/* Cờ Tướng Đạo Pro: luồng chạy Pikafish (WebAssembly). Mã nguồn engine: https://github.com/official-pikafish/Pikafish (GPLv3) */
if(self.name==='em-pthread'){importScripts('pikafish.js')}else{
var mod=null,pend=[];
onmessage=function(e){var d=e.data;
 if(d.t==='init'){importScripts('pikafish.js');
  Pikafish({print:function(l){postMessage({t:'out',l:l})},printErr:function(l){postMessage({t:'err',l:l})},
   preRun:[function(m){m.FS.writeFile('/pikafish.nnue',new Uint8Array(d.net))}]}).then(function(m){mod=m;postMessage({t:'ready'});pend.forEach(function(c){m.ccall('uci_command',null,['string'],[c])});pend=[]},function(err){postMessage({t:'fail',e:String(err)})});return}
 if(d.t==='cmd'){if(mod)mod.ccall('uci_command',null,['string'],[d.c]);else pend.push(d.c)}}}
