// Encode an AudioBuffer as a 16-bit PCM WAV file (Blob).
export function encodeWav(buffer) {
  const nch = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const chans = Array.from({ length: nch }, (_, c) => buffer.getChannelData(c));
  const dataBytes = n * nch * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);          // fmt chunk size
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nch * 2, true); // byte rate
  dv.setUint16(32, nch * 2, true);     // block align
  dv.setUint16(34, 16, true);          // bits per sample
  str(36, 'data');
  dv.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
