// Assina o instalador com a chave privada do Lucas (fica fora do projeto, nunca vai pro GitHub).
// O app instalado só aceita atualização cuja assinatura (Isekai-Setup.exe.sig) bate com a chave pública do main.js.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keyFile = process.env.ISEKAI_CHAVE || path.join(os.homedir(), '.isekai', 'assinatura-privada.pem');
const exe = path.join(__dirname, '..', 'dist', 'Isekai-Setup.exe');

if (!fs.existsSync(keyFile)) {
  console.error('Chave de assinatura não encontrada em ' + keyFile + '. Sem ela a atualização seria recusada pelos amigos.');
  process.exit(1);
}
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const data = fs.readFileSync(exe);
const sig = crypto.sign(null, data, key);
fs.writeFileSync(exe + '.sig', sig.toString('base64'));

const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
const embedded = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').includes(pub);
if (!embedded) {
  console.error('A chave pública do main.js não é a desta chave privada: a atualização seria recusada.');
  process.exit(1);
}
console.log('Assinado: dist/Isekai-Setup.exe.sig');
