// Mesh WebRTC for a small meeting (≤ 6): one RTCPeerConnection per other participant.
// Signals (offer / answer / ice / bye) go through the server (POST /api/meetings/:id/signal) and come
// back on the page's event stream as 'meeting' events — no socket of our own.
// Rule against glare: of any two people, the one with the larger user id sends the offer (both sides
// apply the same rule, whoever joined first); an offer for a connection that already has one starts over.
// Screen share swaps the outgoing video track in place (replaceTrack: no renegotiation).
export class Mesh {
  constructor({ ice, send, onStream, onState }) {
    this.ice = ice || []
    this.send = send // (to, kind, data) => Promise
    this.onStream = onStream // (peerId, MediaStream) => void
    this.onState = onState || (() => {})
    this.pcs = new Map() // peerId -> {pc, queue: [ice], stream}
    this.local = null
    this.videoTrack = null
  }
  setLocal(stream) {
    this.local = stream
    this.videoTrack = stream?.getVideoTracks()[0] || null
  }
  peer(id) {
    let p = this.pcs.get(id)
    if (p) return p
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    p = { pc, queue: [], stream: new MediaStream(), remoteSet: false }
    this.pcs.set(id, p)
    for (const t of this.local?.getTracks() || []) pc.addTrack(t, this.local)
    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, 'ice', e.candidate.toJSON()).catch(() => {}) }
    pc.ontrack = (e) => {
      const s = e.streams[0] || p.stream
      if (!s.getTracks().includes(e.track)) s.addTrack(e.track)
      p.stream = s
      this.onStream(id, s)
    }
    pc.onconnectionstatechange = () => this.onState(id, pc.connectionState)
    return p
  }
  // I am new: offer to someone already there
  async connect(id) {
    const p = this.peer(id)
    const offer = await p.pc.createOffer()
    await p.pc.setLocalDescription(offer)
    await this.send(id, 'offer', { type: offer.type, sdp: offer.sdp })
  }
  async onSignal({ from, kind, data }) {
    if (kind === 'bye') return this.close(from)
    let p = this.peer(from)
    if (kind === 'offer') {
      // they started over (rejoined, reloaded): a fresh connection for the fresh offer
      if (p.pc.remoteDescription || p.pc.signalingState !== 'stable') { this.close(from); p = this.peer(from) }
      await p.pc.setRemoteDescription(data)
      p.remoteSet = true
      await this.flush(p)
      const answer = await p.pc.createAnswer()
      await p.pc.setLocalDescription(answer)
      await this.send(from, 'answer', { type: answer.type, sdp: answer.sdp })
    } else if (kind === 'answer') {
      if (p.pc.signalingState === 'have-local-offer') { await p.pc.setRemoteDescription(data); p.remoteSet = true; await this.flush(p) }
    } else if (kind === 'ice') {
      // candidates can arrive before the description they belong to
      if (p.remoteSet) await p.pc.addIceCandidate(data).catch(() => {})
      else p.queue.push(data)
    }
  }
  async flush(p) {
    const q = p.queue.splice(0)
    for (const c of q) await p.pc.addIceCandidate(c).catch(() => {})
  }
  // screen share (or back to the camera): the same sender, a different track
  async replaceVideo(track) {
    for (const { pc } of this.pcs.values()) {
      const s = pc.getSenders().find((x) => x.track?.kind === 'video' || (!x.track && x !== null))
      if (s) await s.replaceTrack(track).catch(() => {})
    }
  }
  close(id) {
    const p = this.pcs.get(id)
    if (!p) return
    try { p.pc.close() } catch { /* closed */ }
    this.pcs.delete(id)
    this.onState(id, 'closed')
  }
  closeAll() {
    for (const id of [...this.pcs.keys()]) { this.send(id, 'bye', {}).catch(() => {}); this.close(id) }
  }
}
