'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopLyric', {
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop-lyric:update', listener);
    return () => ipcRenderer.removeListener('desktop-lyric:update', listener);
  },
  onLock: (callback) => {
    const listener = (_event, locked) => callback(locked);
    ipcRenderer.on('desktop-lyric:lock', listener);
    return () => ipcRenderer.removeListener('desktop-lyric:lock', listener);
  },
  onFont: (callback) => {
    const listener = (_event, size) => callback(size);
    ipcRenderer.on('desktop-lyric:font', listener);
    return () => ipcRenderer.removeListener('desktop-lyric:font', listener);
  },
  onColors: (callback) => {
    const listener = (_event, colors) => callback(colors);
    ipcRenderer.on('desktop-lyric:colors', listener);
    return () => ipcRenderer.removeListener('desktop-lyric:colors', listener);
  },
  command: (name, arg) => ipcRenderer.send('desktop-lyric:command', name, arg),
});
