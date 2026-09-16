import { connectSignaling } from "./signaling";

export type BroadcastHandle = {
  get viewerCount(): number;
  stop: () => void;
};

export function startBroadcast(options: {
  code: string;
  stream: MediaStream;
  onViewerCount: (count: number) => void;
  onError: (message: string) => void;
}): BroadcastHandle {
  const { code, stream } = options;
  const peers = new Map<string, RTCPeerConnection>();

  const teardownPeers = () => {
    for (const peer of peers.values()) {
      peer.close();
    }
    peers.clear();
    options.onViewerCount(0);
  };

  const session = connectSignaling(code, {
    onOpen() {
      session.send({ type: "join", role: "host" });
    },
    onClose() {
      // The socket dropped; it will reconnect automatically. The server
      // re-sends `viewer-joined` for every waiting viewer once we re-join,
      // so only the stale peer connections need to be torn down here.
      teardownPeers();
    },
    onMessage(message) {
      switch (message.type) {
        case "viewer-joined": {
          const pc = new RTCPeerConnection();
          for (const track of stream.getTracks()) {
            pc.addTrack(track, stream);
          }
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              session.send({
                type: "ice-candidate",
                to: message.peerId,
                candidate: event.candidate.toJSON(),
              });
            }
          };
          peers.set(message.peerId, pc);
          options.onViewerCount(peers.size);
          pc.createOffer()
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
              if (pc.localDescription) {
                session.send({ type: "offer", to: message.peerId, sdp: pc.localDescription });
              }
            })
            .catch((error: unknown) => options.onError(String(error)));
          break;
        }
        case "answer": {
          peers
            .get(message.from)
            ?.setRemoteDescription(message.sdp)
            .catch(() => {});
          break;
        }
        case "ice-candidate": {
          const peer = peers.get(message.from);
          if (peer && message.candidate) {
            peer.addIceCandidate(message.candidate).catch(() => {});
          }
          break;
        }
        case "viewer-left": {
          const peer = peers.get(message.peerId);
          peer?.close();
          peers.delete(message.peerId);
          options.onViewerCount(peers.size);
          break;
        }
        case "error":
          options.onError(message.message);
          break;
      }
    },
  });

  return {
    get viewerCount() {
      return peers.size;
    },
    stop() {
      teardownPeers();
      session.close();
    },
  };
}
