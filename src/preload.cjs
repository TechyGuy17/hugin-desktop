// preload.cjs
const { contextBridge, ipcRenderer } = require('electron')

const WINDOW_API = {

  //GENERAL API CALLS
  send: (channel, data) => {
    ipcRenderer.send(channel, data)
  },
  sendSync: (channel, data) => {
    ipcRenderer.sendSync(channel, data)
  },
  receive: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args))
  },


  // SEND MESSAGES
  sendMsg: (msg, address, key) => {
    ipcRenderer.send('sendMsg', msg, address, key )
  },
  sendBoardMsg: (msg, address, key) => {
    ipcRenderer.send('sendBoardMsg', msg, address, key )
  },

  //HANDLE NODES
  getNodes: async () => {
    ipcRenderer.send('getNodes')
  },
  switchNode: node => (
      ipcRenderer.send('switchNode', node)
  )
}


contextBridge.exposeInMainWorld('api', WINDOW_API);