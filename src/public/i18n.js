// Minimal i18n with no build step. Add strings to STRINGS under each locale
// with the same key. Locale resolution, highest priority first:
//   1. ?lang= in the URL
//   2. the previously chosen language (localStorage)
//   3. the browser's preferred languages (pt -> pt-BR, en -> en)
//   4. the default locale (pt-BR)
// Elements opt in with data-i18n / data-i18n-html / data-i18n-placeholder /
// data-i18n-title / data-i18n-aria-label. A <select data-lang-select> is filled
// with the supported locales and reloads the page on change.
(function () {
  "use strict";

  const DEFAULT = "pt-BR";
  const SUPPORTED = ["pt-BR", "en"];
  const LOCALE_NAMES = { "pt-BR": "Português", en: "English" };
  const STORAGE_KEY = "golive.lang";

  const STRINGS = {
    "pt-BR": {
      // Landing page
      "home.tagline": "Compartilhe sua tela com os amigos por um link privado. O WebRTC leva a mídia direto entre os navegadores — nada passa pelo servidor.",
      "home.host": "Host",
      "home.hostDesc": "Compartilhe sua tela, uma janela ou aba e envie o link da sala para os amigos.",
      "home.watch": "Assistir",
      "home.watchDesc": "Digite o código da sala que você recebeu.",
      "home.roomCode": "código da sala",
      "home.roomCodeAria": "Código da sala",
      "home.watchBtn": "Assistir",
      "home.invalidCode": "O código da sala tem de 3 a 24 caracteres: a–z, 0–9, - ou _.",
      "home.howTitle": "Como funciona",
      "home.how1": "O host cria uma sala e compartilha o link (ou o QR code) com quem vai assistir.",
      "home.how2": "O vídeo e o áudio vão direto entre os navegadores (WebRTC ponto a ponto). O servidor só ajuda a combinar a conexão — ele nunca vê nem grava a sua tela.",
      "home.how3": "O host envia uma transmissão por espectador, então a banda de upload define quantos podem assistir e com que qualidade.",
      "home.needTitle": "O que é preciso",
      "home.need1": "Um navegador atual. Para transmitir, Chrome, Edge ou Firefox no desktop (compartilhar tela no Safari é limitado).",
      "home.need2": "Um endereço seguro (HTTPS) para capturar a tela — esta página já usa HTTPS.",
      "home.need3": "Não há servidor de relay (TURN), então os dois lados precisam se conectar direto. NAT rígido ou firewall corporativo pode bloquear; IPv6 ajuda.",
      "home.need4": "O áudio da tela depende do navegador e da fonte: uma aba ou a tela inteira no Chrome (Windows, ChromeOS, macOS 14.2+). Firefox e Safari não compartilham áudio.",
      "home.need5": "Até 8 espectadores por sala (padrão).",

      // App chrome
      "app.startSharing": "Iniciar transmissão",
      "app.stop": "Parar",
      "app.roomId": "ID da sala",
      "app.randomRoom": "Gerar um ID aleatório",
      "app.preferAv1": "Preferir AV1",
      "app.shareAudio": "Compartilhar áudio",
      "app.quality": "Qualidade",
      "app.roomLink": "Link da sala",
      "app.copyLink": "Copiar link",
      "app.copied": "Copiado!",
      "app.audioHint": "🔊 Áudio da transmissão disponível — começa mudo pelo navegador. Clique para ativar o som.",
      "app.unmute": "Ativar som",
      "app.volume": "Volume",
      "app.pip": "Picture-in-picture",
      "app.exitPip": "Sair do picture-in-picture",
      "app.diagnostics": "Diagnósticos",
      "app.log": "Registro",
      "app.clear": "Limpar",
      "app.language": "Idioma",
      "link.share": "Compartilhar",
      "link.qr": "QR code",
      "qr.title": "Escaneie para abrir no celular",
      "qr.hint": "Aponte a câmera do celular para o código.",
      "qr.close": "Fechar",
      "share.text": "Entre na minha sala do Golive",
      "log.show": "Mostrar registro",
      "log.hide": "Ocultar registro",

      // Diagnostics labels
      "diag.signaling": "Sinalização",
      "diag.viewers": "Espectadores conectados",
      "diag.upload": "Upload total",
      "diag.forViewer": "Diagnósticos de",
      "diag.reconnect": "Reconectar",
      "diag.copy": "Copiar diagnósticos",
      "diag.ice": "Estado da conexão ICE",
      "diag.pc": "Estado da conexão P2P",
      "diag.av1": "Suporte a AV1 (este navegador)",
      "diag.pair": "Par de candidatos selecionado",
      "diag.path": "Caminho",
      "diag.ipv6": "Candidato IPv6 (reflexivo)",
      "diag.rtt": "Tempo de ida e volta",
      "diag.loss": "Perda de pacotes",
      "diag.jitter": "Jitter",
      "diag.freeze": "Congelamentos",
      "diag.videoCodec": "Codec de vídeo (real)",
      "diag.res": "Resolução",
      "diag.fps": "Taxa de quadros",
      "diag.limit": "Limite de qualidade",
      "diag.bitrate": "Taxa de bits",
      "diag.quality": "Predefinição de qualidade",
      "diag.audioCodec": "Codec de áudio (real)",
      "diag.audioBitrate": "Taxa de bits do áudio",
      "diag.impl": "Implementação do codec",
      "diag.cands": "Candidatos coletados",
      "diag.implPowerEfficient": " (eficiente em energia)",

      // Roles and headers
      "role.host": "Host",
      "role.viewer": "Espectador · sala {room}",
      "sub.host": "Compartilhe sua tela com os amigos por um link privado. Qualquer pessoa com o link da sala pode entrar — não compartilhe conteúdo privado.",
      "sub.viewer": "Você está assistindo a uma tela compartilhada por um link privado. Use os controles do player para ativar o som.",

      // Player placeholder
      "placeholder.start": "Clique em “Iniciar transmissão” para começar a captura",
      "placeholder.waiting": "Aguardando quem transmite…",
      "placeholder.disconnected": "Desconectado",

      // Peers
      "peer.streamer": "quem transmite",
      "peer.viewer": "espectador {id}",
      "peer.none": "(sem espectadores)",

      // AV1 support probe
      "support.send": "envio",
      "support.receive": "recebimento",
      "support.yes": "sim",
      "support.no": "não",
      "support.unknown": "desconhecido (getCapabilities indisponível)",

      // Signaling status values
      "signal.connecting": "conectando…",
      "signal.connected": "conectado",
      "signal.error": "erro",
      "signal.closed": "fechado",
      "signal.idle": "inativo",

      // Media description
      "media.videoAudio": "vídeo + áudio",
      "media.videoOnly": "somente vídeo",

      // Candidate pair / path
      "pair.local": "local",
      "pair.remote": "remoto",
      "path.relayed": "RETRANSMITIDO (TURN)",
      "path.direct": "direto",
      "path.overIpv6": " via IPv6",
      "path.overIpv4": " via IPv4",
      "path.familyHidden": " (família de endereços oculta pelo navegador)",
      "ipv6.srflx": "sim — srflx IPv6 coletado",
      "ipv6.hostOnly": "somente host (sem srflx — IPv6 pode estar bloqueado)",
      "ipv6.none": "não — sem IPv6",
      "limit.none": "nenhum",
      "limit.cpu": "CPU",
      "limit.bandwidth": "banda",
      "limit.other": "outro",

      // Quality presets
      "preset.4k60": "4K · 60 fps · até 40 Mbps",
      "preset.4k60.short": "4K / 60 fps",
      "preset.4k30": "4K · 30 fps · até 25 Mbps",
      "preset.4k30.short": "4K / 30 fps",
      "preset.1440p60": "1440p · 60 fps · até 20 Mbps",
      "preset.1440p60.short": "1440p / 60 fps",
      "preset.1080p60": "1080p · 60 fps · até 12 Mbps",
      "preset.1080p60.short": "1080p / 60 fps",
      "preset.1080p30": "1080p · 30 fps · até 8 Mbps",
      "preset.1080p30.short": "1080p / 30 fps",
      "preset.text": "Texto / nítido · 15 fps · até 8 Mbps",
      "preset.text.short": "Texto / nítido",
      "preset.720p30": "720p · 30 fps · até 4 Mbps",
      "preset.720p30.short": "720p / 30 fps",
      "preset.low": "Economia de dados · 24 fps · até 1 Mbps",
      "preset.low.short": "Economia de dados (1 Mbps)",
      "preset.auto": "Automático (padrão do navegador)",
      "preset.auto.short": "Automático (padrão)",

      // Log lines
      "log.qualityApplyFailed": "Não foi possível aplicar a predefinição “{label}”: {message}",
      "log.av1Disabled": "Preferência por AV1 desativada: usando a ordem padrão de codecs do navegador.",
      "log.codecPrefsUnsupported": "setCodecPreferences() não é suportado por este navegador.",
      "log.av1NotSupported": "AV1 não reportado como suportado; mantendo a ordem padrão de codecs.",
      "log.codecPrefsSet": "Preferência de codec definida: AV1 primeiro, {count} alternativas mantidas.",
      "log.codecPrefsFailed": "Falha em setCodecPreferences: {message}",
      "log.av1UnavailableSend": "AV1 não está disponível para envio neste navegador; será usado um codec alternativo.",
      "log.av1UnavailableRecv": "AV1 não está disponível para recebimento neste navegador; será usado um codec alternativo.",
      "log.signalUnreachable": "Não foi possível alcançar o servidor de sinalização",
      "log.signalHandleError": "Erro ao tratar sinal: {message}",
      "log.reconnecting": "Reconectando à sala “{room}”…",
      "log.reconnected": "Sinalização reconectada.",
      "log.roomLive": "A sala “{room}” está no ar. Compartilhe o link para convidar espectadores.",
      "log.joined": "Entrou na sala {room}.",
      "log.viewerJoined": "Espectador {id} entrou; criando oferta.",
      "log.viewerLeft": "Espectador {id} saiu.",
      "log.streamerLeft": "Quem transmite parou de compartilhar. Aguardando voltar…",
      "log.serverError": "Servidor: {message}",
      "log.iceGatheringComplete": "[{peer}] Coleta de ICE concluída.",
      "log.iceCandidateError": "[{peer}] Erro de candidato ICE {code} {text}",
      "log.iceGathering": "[{peer}] Coleta de ICE: {state}",
      "log.pcState": "[{peer}] Estado da conexão P2P: {state}",
      "log.remoteAudio": "Faixa de áudio remota recebida. Use o botão de ativar som ou os controles do player para ouvir.",
      "log.remoteVideo": "Faixa de vídeo remota recebida.",
      "log.iceState": "[{peer}] Estado da conexão ICE: {state}",
      "log.iceRestart": "[{peer}] O ICE caiu; reiniciando a conexão (tentativa {attempt}).",
      "log.iceRestartFailed": "[{peer}] Falha ao reiniciar o ICE: {message}",
      "log.iceRestartGaveUp": "[{peer}] O ICE não se recuperou após várias tentativas.",
      "log.localCandidate": "[{peer}] Candidato local: {family} {type} ({proto})",
      "log.offerSent": "Oferta enviada para {peer} ({media}).",
      "log.answerSent": "Resposta enviada.",
      "log.answerReceived": "[{peer}] Resposta recebida.",
      "log.addCandidateFailed": "Falha em addIceCandidate: {message}",
      "log.codecNotAv1": "[{peer}] O codec negociado é {mime}, não AV1.",
      "log.codecIsAv1": "[{peer}] Codec negociado: video/AV1",
      "log.sharingStopped": "Transmissão encerrada.",
      "log.roomIdInvalid": "ID de sala inválido “{id}”. Use de 3 a 24 caracteres: a–z, 0–9, - ou _, começando com letra ou número.",
      "log.audioRejected": "Este navegador/fonte recusou a captura de áudio ({name}); tentando novamente somente com vídeo.",
      "log.captureFailed": "Falha na captura de tela: {name}: {message}",
      "log.noAudioTrack": "A fonte selecionada não forneceu faixa de áudio. Abas e telas podem compartilhar áudio; uma janela compartilha apenas o próprio áudio quando o navegador suporta — tente uma aba do Chrome ou a tela inteira com “Compartilhar áudio do sistema”. Compartilhando somente vídeo.",
      "log.audioEnabled": "Captura de áudio ativada com vídeo a {fps} fps; a faixa de áudio será enviada a cada espectador.",
      "log.videoOnly": "Compartilhando somente vídeo a {fps} fps.",
      "log.qualityPreset": "Predefinição de qualidade: {label}.",
      "log.captureEnded": "Captura de tela encerrada pelo navegador.",
      "log.linkCopied": "Link copiado.",
      "log.clipboardUnavailable": "Área de transferência indisponível; link selecionado — copie manualmente.",
      "log.qualityChanged": "Predefinição de qualidade definida para “{label}”.",
      "log.uploadHigh": "O upload total está em ~{mbps} Mbps para {count} espectador(es); sua conexão pode sofrer — considere uma predefinição de qualidade menor.",
      "log.wakeLockOn": "Tela mantida ativa enquanto a transmissão está em andamento.",
      "log.manualReconnect": "[{peer}] Reconexão manual: reiniciando o ICE.",
      "log.manualReconnectViewer": "Reconexão manual: refazendo a sinalização para receber uma nova oferta.",
      "log.diagCopied": "Diagnósticos copiados para a área de transferência.",
      "log.renegotiateRequested": "O viewer {id} pediu para reconstruir a conexão; enviando uma nova oferta.",
      "log.viewerRecovering": "Conexão travada — pedindo ao host para reconstruir a transmissão (tentativa {attempt}/{max}).",
      "log.viewerRecoveryGaveUp": "Não foi possível recuperar a conexão automaticamente. Clique em Reconectar.",
      "log.offerSkippedNoStream": "Oferta ignorada: não há transmissão ativa.",
      "log.retrying": "{message}; tentando novamente…",
      "log.linkShared": "Link compartilhado.",
      "log.qrFailed": "Não foi possível gerar o QR code.",

      // Alerts
      "alert.iceFailed": "ICE falhou: não há caminho direto entre os pares. Nenhum relay TURN está configurado, então a mídia não foi retransmitida. Verifique firewalls/NAT, tente redes diferentes ou confirme que ambos os lados têm IPv6 funcionando. Tentando reconectar automaticamente.",
      "alert.iceDisconnected": "ICE desconectado. Pode se recuperar; se não, a conexão passará para falha.",
      "alert.av1Fallback": "AV1 foi preferido, mas o codec negociado é {mime}. Verifique o suporte a AV1 nos dois lados.",
      "alert.roomIdInvalid": "O ID da sala deve ter de 3 a 24 caracteres (a–z, 0–9, - ou _), começando com letra ou número.",
      "alert.captureDenied": "A captura de tela foi cancelada ou negada.",
      "alert.captureInsecure": "A captura de tela exige um contexto seguro (HTTPS ou localhost).",
      "alert.roomInUse": "Esse ID de sala já está em uso. Escolha outro.",
      "alert.roomFull": "A sala está cheia. Tente novamente mais tarde.",
      "hint.iceLan": "Se vocês dois estão na mesma rede Wi-Fi, isolação de clientes no roteador ou o firewall do sistema (Windows em rede “Pública”) costuma ser a causa dessas falhas locais — tire um dos lados do Wi-Fi (rede móvel) para confirmar.",
      "hint.iceNoStun": "O STUN não retornou um endereço público; um firewall ou VPN pode estar bloqueando UDP/STUN.",
    },

    en: {
      "home.tagline": "Share your screen with friends over a private link. WebRTC carries the media peer-to-peer — nothing passes through the server.",
      "home.host": "Host",
      "home.hostDesc": "Share your screen, window or tab and send the room link to friends.",
      "home.watch": "Watch",
      "home.watchDesc": "Enter the room code you were given.",
      "home.roomCode": "room code",
      "home.roomCodeAria": "Room code",
      "home.watchBtn": "Watch",
      "home.invalidCode": "A room code is 3–24 characters: a–z, 0–9, - or _.",
      "home.howTitle": "How it works",
      "home.how1": "The host creates a room and shares the link (or the QR code) with the viewers.",
      "home.how2": "Video and audio travel directly between the browsers (WebRTC peer-to-peer). The server only helps set up the connection — it never sees or records your screen.",
      "home.how3": "The host sends one stream per viewer, so upload bandwidth sets how many can watch and at what quality.",
      "home.needTitle": "What it needs",
      "home.need1": "A current browser. To host, Chrome, Edge or Firefox on desktop (screen sharing is limited in Safari).",
      "home.need2": "A secure address (HTTPS) to capture the screen — this page already uses HTTPS.",
      "home.need3": "There is no relay server (TURN), so both sides must connect directly. Strict NAT or corporate firewalls can block it; IPv6 helps.",
      "home.need4": "Screen audio depends on the browser and source: a tab or the whole screen in Chrome (Windows, ChromeOS, macOS 14.2+). Firefox and Safari don't share it.",
      "home.need5": "Up to 8 viewers per room (default).",

      "app.startSharing": "Start sharing",
      "app.stop": "Stop",
      "app.roomId": "Room ID",
      "app.randomRoom": "Generate a random ID",
      "app.preferAv1": "Prefer AV1",
      "app.shareAudio": "Share audio",
      "app.quality": "Quality",
      "app.roomLink": "Room link",
      "app.copyLink": "Copy link",
      "app.copied": "Copied!",
      "app.audioHint": "🔊 Stream audio available — starts muted by browser. Click to unmute.",
      "app.unmute": "Unmute",
      "app.volume": "Volume",
      "app.pip": "Picture-in-picture",
      "app.exitPip": "Exit picture-in-picture",
      "app.diagnostics": "Diagnostics",
      "app.log": "Log",
      "app.clear": "Clear",
      "app.language": "Language",
      "link.share": "Share",
      "link.qr": "QR code",
      "qr.title": "Scan to open on your phone",
      "qr.hint": "Point your phone camera at the code.",
      "qr.close": "Close",
      "share.text": "Join my Golive room",
      "log.show": "Show log",
      "log.hide": "Hide log",

      "diag.signaling": "Signaling",
      "diag.viewers": "Connected viewers",
      "diag.upload": "Total upload",
      "diag.forViewer": "Diagnostics for",
      "diag.reconnect": "Reconnect",
      "diag.copy": "Copy diagnostics",
      "diag.ice": "ICE connection state",
      "diag.pc": "Peer connection state",
      "diag.av1": "AV1 support (this browser)",
      "diag.pair": "Selected candidate pair",
      "diag.path": "Path",
      "diag.ipv6": "IPv6 candidate (reflexive)",
      "diag.rtt": "Round-trip time",
      "diag.loss": "Packet loss",
      "diag.jitter": "Jitter",
      "diag.freeze": "Freezes",
      "diag.videoCodec": "Video codec (actual)",
      "diag.res": "Resolution",
      "diag.fps": "Frame rate",
      "diag.limit": "Quality limit",
      "diag.bitrate": "Bitrate",
      "diag.quality": "Quality preset",
      "diag.audioCodec": "Audio codec (actual)",
      "diag.audioBitrate": "Audio bitrate",
      "diag.impl": "Codec implementation",
      "diag.cands": "Gathered candidates",
      "diag.implPowerEfficient": " (power efficient)",

      "role.host": "Host",
      "role.viewer": "Viewer · room {room}",
      "sub.host": "Share your screen with friends over a private link. Anyone with the room link can join — don't share private content.",
      "sub.viewer": "You are watching a screen shared over a private link. Use the player controls to unmute sound.",

      "placeholder.start": "Click “Start sharing” to begin screen capture",
      "placeholder.waiting": "Waiting for the streamer…",
      "placeholder.disconnected": "Disconnected",

      "peer.streamer": "streamer",
      "peer.viewer": "viewer {id}",
      "peer.none": "(no viewers)",

      "support.send": "send",
      "support.receive": "receive",
      "support.yes": "yes",
      "support.no": "no",
      "support.unknown": "unknown (getCapabilities unavailable)",

      "signal.connecting": "connecting…",
      "signal.connected": "connected",
      "signal.error": "error",
      "signal.closed": "closed",
      "signal.idle": "idle",

      "media.videoAudio": "video + audio",
      "media.videoOnly": "video only",

      "pair.local": "local",
      "pair.remote": "remote",
      "path.relayed": "RELAYED (TURN)",
      "path.direct": "direct",
      "path.overIpv6": " over IPv6",
      "path.overIpv4": " over IPv4",
      "path.familyHidden": " (address family hidden by browser)",
      "ipv6.srflx": "yes — IPv6 srflx gathered",
      "ipv6.hostOnly": "host only (no srflx — IPv6 may be blocked)",
      "ipv6.none": "no — no IPv6",
      "limit.none": "none",
      "limit.cpu": "CPU",
      "limit.bandwidth": "bandwidth",
      "limit.other": "other",

      "preset.4k60": "4K · 60 fps · up to 40 Mbps",
      "preset.4k60.short": "4K / 60 fps",
      "preset.4k30": "4K · 30 fps · up to 25 Mbps",
      "preset.4k30.short": "4K / 30 fps",
      "preset.1440p60": "1440p · 60 fps · up to 20 Mbps",
      "preset.1440p60.short": "1440p / 60 fps",
      "preset.1080p60": "1080p · 60 fps · up to 12 Mbps",
      "preset.1080p60.short": "1080p / 60 fps",
      "preset.1080p30": "1080p · 30 fps · up to 8 Mbps",
      "preset.1080p30.short": "1080p / 30 fps",
      "preset.text": "Text / sharp · 15 fps · up to 8 Mbps",
      "preset.text.short": "Text / sharp",
      "preset.720p30": "720p · 30 fps · up to 4 Mbps",
      "preset.720p30.short": "720p / 30 fps",
      "preset.low": "Data saver · 24 fps · up to 1 Mbps",
      "preset.low.short": "Data saver (1 Mbps)",
      "preset.auto": "Auto (browser default)",
      "preset.auto.short": "Auto (default)",

      "log.qualityApplyFailed": "Could not apply quality preset “{label}”: {message}",
      "log.av1Disabled": "AV1 preference disabled: using the browser's default codec order.",
      "log.codecPrefsUnsupported": "setCodecPreferences() is not supported by this browser.",
      "log.av1NotSupported": "AV1 not reported as supported; leaving default codec order.",
      "log.codecPrefsSet": "Codec preference set: AV1 first, {count} fallback entries kept.",
      "log.codecPrefsFailed": "setCodecPreferences failed: {message}",
      "log.av1UnavailableSend": "AV1 is not available for sending in this browser; a fallback codec will be used.",
      "log.av1UnavailableRecv": "AV1 is not available for receiving in this browser; a fallback codec will be used.",
      "log.signalUnreachable": "Could not reach the signaling server",
      "log.signalHandleError": "Signal handling error: {message}",
      "log.reconnecting": "Reconnecting to room “{room}”…",
      "log.reconnected": "Signaling reconnected.",
      "log.roomLive": "Room “{room}” is live. Share the link to invite viewers.",
      "log.joined": "Joined room {room}.",
      "log.viewerJoined": "Viewer {id} joined; creating offer.",
      "log.viewerLeft": "Viewer {id} left.",
      "log.streamerLeft": "Streamer stopped sharing. Waiting for it to come back…",
      "log.serverError": "Server: {message}",
      "log.iceGatheringComplete": "[{peer}] ICE gathering complete.",
      "log.iceCandidateError": "[{peer}] ICE candidate error {code} {text}",
      "log.iceGathering": "[{peer}] ICE gathering: {state}",
      "log.pcState": "[{peer}] Peer connection state: {state}",
      "log.remoteAudio": "Remote audio track received. Use the unmute button or player controls to listen.",
      "log.remoteVideo": "Remote video track received.",
      "log.iceState": "[{peer}] ICE connection state: {state}",
      "log.iceRestart": "[{peer}] ICE dropped; restarting the connection (attempt {attempt}).",
      "log.iceRestartFailed": "[{peer}] ICE restart failed: {message}",
      "log.iceRestartGaveUp": "[{peer}] ICE did not recover after several attempts.",
      "log.localCandidate": "[{peer}] Local candidate: {family} {type} ({proto})",
      "log.offerSent": "Offer sent to {peer} ({media}).",
      "log.answerSent": "Answer sent.",
      "log.answerReceived": "[{peer}] Answer received.",
      "log.addCandidateFailed": "addIceCandidate failed: {message}",
      "log.codecNotAv1": "[{peer}] Negotiated codec is {mime}, not AV1.",
      "log.codecIsAv1": "[{peer}] Negotiated codec: video/AV1",
      "log.sharingStopped": "Sharing stopped.",
      "log.roomIdInvalid": "Invalid room ID “{id}”. Use 3–24 chars: a–z, 0–9, - or _, starting with a letter or number.",
      "log.audioRejected": "This browser/source rejected audio capture ({name}); retrying with video only.",
      "log.captureFailed": "Screen capture failed: {name}: {message}",
      "log.noAudioTrack": "The selected source provided no audio track. Tabs and screens can share audio; a window shares only its own audio where the browser supports it — try a Chrome tab or the entire screen with “Share system audio”. Sharing video only.",
      "log.audioEnabled": "Audio capture enabled at {fps} fps video; the audio track will be sent to each viewer.",
      "log.videoOnly": "Sharing video only at {fps} fps.",
      "log.qualityPreset": "Quality preset: {label}.",
      "log.captureEnded": "Screen capture ended by the browser.",
      "log.linkCopied": "Link copied.",
      "log.clipboardUnavailable": "Clipboard unavailable; link selected — copy it manually.",
      "log.qualityChanged": "Quality preset set to “{label}”.",
      "log.uploadHigh": "Total upload is ~{mbps} Mbps across {count} viewer(s); your connection may struggle — consider a lower quality preset.",
      "log.wakeLockOn": "Screen kept awake while the stream is running.",
      "log.manualReconnect": "[{peer}] Manual reconnect: restarting ICE.",
      "log.manualReconnectViewer": "Manual reconnect: re-opening signaling to get a fresh offer.",
      "log.diagCopied": "Diagnostics copied to the clipboard.",
      "log.renegotiateRequested": "Viewer {id} asked to rebuild the connection; sending a fresh offer.",
      "log.viewerRecovering": "Connection stalled — asking the host to rebuild the stream (attempt {attempt}/{max}).",
      "log.viewerRecoveryGaveUp": "Could not recover the connection automatically. Click Reconnect.",
      "log.offerSkippedNoStream": "Offer skipped: no active capture.",
      "log.retrying": "{message}; retrying…",
      "log.linkShared": "Link shared.",
      "log.qrFailed": "Could not generate the QR code.",

      "alert.iceFailed": "ICE failed: no direct path between the peers. No TURN relay is configured, so media was not relayed. Check firewalls/NAT, try different networks, or verify that both sides have working IPv6. Retrying automatically.",
      "alert.iceDisconnected": "ICE disconnected. It may recover; if not, the connection will move to failed.",
      "alert.av1Fallback": "AV1 was preferred but the negotiated codec is {mime}. Check AV1 support on both peers.",
      "alert.roomIdInvalid": "Room ID must be 3–24 characters (a–z, 0–9, - or _), starting with a letter or number.",
      "alert.captureDenied": "Screen capture was cancelled or denied.",
      "alert.captureInsecure": "Screen capture requires a secure context (HTTPS or localhost).",
      "alert.roomInUse": "That room ID is already live. Pick another one.",
      "alert.roomFull": "The room is full. Try again later.",
      "hint.iceLan": "If you're both on the same Wi-Fi, router client isolation or the OS firewall (Windows set to a Public network) is the usual cause of this kind of local failure — take one side off Wi-Fi (mobile data) to confirm.",
      "hint.iceNoStun": "STUN didn't return a public address; a firewall or VPN may be blocking UDP/STUN.",
    },
  };

  function normalize(tag) {
    const v = String(tag || "").toLowerCase();
    if (v.startsWith("pt")) return "pt-BR";
    if (v.startsWith("en")) return "en";
    return null;
  }

  function detect() {
    try {
      const fromUrl = normalize(new URLSearchParams(location.search).get("lang"));
      if (fromUrl) return fromUrl;
    } catch { /* no URL */ }
    try {
      const stored = normalize(localStorage.getItem(STORAGE_KEY));
      if (stored) return stored;
    } catch { /* storage unavailable */ }
    const langs = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ""];
    for (const l of langs) {
      const n = normalize(l);
      if (n) return n;
    }
    return DEFAULT;
  }

  let locale = detect();

  function t(key, vars) {
    const dict = STRINGS[locale] || STRINGS[DEFAULT];
    let s = dict[key];
    if (s == null) s = STRINGS[DEFAULT][key];
    if (s == null) return key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return s;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
    });
  }

  function setLocale(next) {
    const n = normalize(next);
    if (!n || n === locale) return;
    locale = n;
    try { localStorage.setItem(STORAGE_KEY, n); } catch { /* storage unavailable */ }
    document.documentElement.lang = n;
  }

  function wireSelects() {
    document.querySelectorAll("[data-lang-select]").forEach((sel) => {
      sel.innerHTML = "";
      for (const code of SUPPORTED) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = LOCALE_NAMES[code] || code;
        sel.appendChild(opt);
      }
      sel.value = locale;
      sel.addEventListener("change", () => {
        setLocale(sel.value);
        location.reload();
      });
    });
  }

  document.documentElement.lang = locale;
  window.t = t;
  window.i18n = { locale: () => locale, setLocale, apply, detect, SUPPORTED, DEFAULT };

  function boot() {
    apply();
    wireSelects();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
