import Module from '../src/.';

const module = new Module(null, null, 'https://www.youtube.com/watch?v=G9r7-CN5--M');
module.on('message', (data)=>console.info(JSON.stringify(data)))
module.connect();
setTimeout(()=>module.disconnect(), 15000);