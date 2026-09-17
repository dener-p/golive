import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const LOCALES = ["en", "pt-BR"] as const;

export type Locale = (typeof LOCALES)[number];

const en = {
  signIn: "Sign In",
  signOut: "Sign Out",
  settings: "Settings",
  myAccount: "My Account",
  toggleTheme: "Toggle theme",
  light: "Light",
  dark: "Dark",
  system: "System",
  selectLanguage: "Select language",
  inviteOnly: "invite-only · free · discord login",
  homeTagline:
    "Share your screen live — up to 1080p 60fps — with just a room code. No downloads, no accounts beyond Discord. Viewers land on the page and the stream just plays.",
  startStreaming: "Start streaming",
  startStreamingDesc: "Create a room, pick a screen or window, and share the link.",
  goToStudio: "Go to studio",
  watchAStream: "Watch a stream",
  watchAStreamDesc:
    "Join a room by code. If no one is live yet, it starts automatically when they do.",
  roomCodePlaceholder: "Room code, e.g. 83jkf",
  join: "Join",
  welcomeToGoLive: "Welcome to GoLive",
  discordOnlySignIn: "Share your screen with friends. Discord is the only way in.",
  redirectingToDiscord: "Redirecting to Discord...",
  continueWithDiscord: "Continue with Discord",
  welcomeBack: "Welcome back",
  welcomeBackDesc:
    "{name}. Create a room to stream, or jump into one someone shared with you.",
  startATransmission: "Start a transmission",
  startATransmissionDesc:
    "Create a room and you'll get a short code. Anyone with the link can watch — they just need a Discord account.",
  titleLabel: "Title",
  titlePlaceholder: "e.g. Weekend games",
  creating: "Creating…",
  createRoomAndOpenStudio: "Create room & open studio",
  createTransmissionFailed: "Failed to create transmission",
  roomCode: "Room code",
  roomCodeHint: "Room codes are case-insensitive — no need to type the “#”.",
  settingsDesc:
    "Webhook API keys let you push your own TURN relay. Credentials stay in memory until they expire — nothing is persisted.",
  activeTurnRelay: "Active TURN relay",
  refresh: "Refresh",
  state: "State",
  expired: "Expired",
  fresh: "Fresh",
  username: "Username",
  pushed: "Pushed",
  expires: "Expires",
  sourceKey: "Source key",
  noRelayConfig:
    "No relay config. Create a key and push your TURN server to get relayed connections.",
  testConnection: "Test connection",
  webhookApiKeys: "Webhook API keys",
  newKey: "New key",
  keyNamePlaceholder: "e.g. My coturn",
  create: "Create",
  revoked: "Revoked",
  revoke: "Revoke",
  keyCreatedCopySecret: "Key created — copy the secret now",
  keyId: "Key id (X-Turn-Key)",
  secret: "Secret",
  copy: "Copy",
  secretShownOnce:
    "This secret is shown once. With it you sign webhook requests (HMAC over the timestamp). If you lose it, revoke the key and create a new one.",
  copyCurlExample: "Copy curl example",
  deleteConfirm: "Delete this API key? It can no longer be used.",
  createKeyFailed: "Failed to create key",
  revokeKeyFailed: "Failed to revoke key",
  deleteKeyFailed: "Failed to delete key",
  copied: "Copied",
  relayUrlReturned: "{count} relay url returned",
  relayUrlsReturned: "{count} relay urls returned",
  noRelayConfigured:
    "No relay configured or it expired — clients will connect directly only",
  testFailed: "Test failed: {message}",
  never: "never",
  secondsAgo: "{s}s ago",
  minutesAgo: "{m}m ago",
  hoursAgo: "{h}h ago",
  createdUsed: "Created {created} · Used {used}",
  roomNotFound: "Room not found",
  couldNotLoadRoom: "Could not load this room",
  checkRoomCode: "Check the room code you were given and try again.",
  notTheHost: "You're not the host of this room",
  watchInstead: "Watch it instead",
  transmission: "Transmission",
  broadcastStudio: "Broadcast studio",
  live: "LIVE",
  viewer: "viewer",
  viewers: "viewers",
  copyLink: "Copy link",
  endStream: "End stream",
  waitingForPicker: "Waiting for picker…",
  goLive: "Go Live",
  screenShareCancelled: "Screen sharing was cancelled",
  couldNotStartScreenShare: "Could not start screen sharing",
  readyWhenYouAre: "Ready when you are",
  goLivePickerDesc:
    "Hit Go Live, pick a screen or window, and up to {res} video will be sent to everyone in this room.",
  streamQuality: "Stream quality",
  qualityLow: "Low",
  qualityMedium: "Medium",
  qualityHigh: "High",
  shareUrl: "Share {url}",
  broadcastingFooter:
    "You're broadcasting to everyone in room #{code}. Ending the stream (or closing the share picker) stops it for all viewers.",
  roomReadyFooter:
    "The room is ready. Viewers who open your link will wait here and your stream will play automatically the moment you go live.",
  share: "Share",
  reconnecting: "Reconnecting…",
  connecting: "Connecting…",
  streamOffline: "The stream is offline",
  hostNotStarted: "{name} hasn't started yet. ",
  hostNotStartedGeneric: "The host hasn't started yet. ",
  willPlayHere: "It will play here automatically the moment they go live.",
  watchingRoomChanges: "Watching this room for changes…",
  clickToUnmute: "Click to unmute",
  unmute: "Unmute",
  mute: "Mute",
  thisStream: "this stream",
  watchingStart: "Watching",
  with: "with",
  inviteMore: "Share room #{code} to invite more people.",
  roomStaysOpen: "This room stays open — new viewers can join any time.",
  theHost: "the host",
  help: "Help",
  helpTitle: "Can't see the stream?",
  helpIntro:
    "GoLive sends a browser-to-browser stream (WebRTC). Some networks — corporate proxies, strict routers, some mobile carriers — block that direct link, so the stream stays on “Connecting…” or “Reconnecting…” even while the host is live. Either option below fixes it.",
  helpOption1Title: "Option 1 · Push your own TURN relay",
  helpOption1Desc:
    "A TURN server relays your stream when direct connections fail. You push yours through the webhook API.",
  helpStep1: "Open Settings and create a Webhook API key.",
  helpStep2:
    "Run the generated curl command with your TURN server's address, username and password. The secret signs each request and is only shown once.",
  helpStep3:
    "Push it again before it expires. Credentials live in memory and expire after the TTL (1 hour by default, up to 24h), so re-send them — e.g. with a cron job — to keep the relay alive.",
  helpTestTitle: "Verify it works",
  helpTestDesc:
    "Use Settings → Test connection — it shows how many relay URLs are being returned.",
  helpSettingsButton: "Open Settings",
  helpOption2Title: "Option 2 · Use Tailscale",
  helpOption2Desc:
    "Install Tailscale on the host machine and on any viewer who can't connect, signing all devices into the same tailnet. The stream then travels over your private Tailscale network, which reaches past most restrictive NATs — no webhook needed.",
  helpNote:
    "You never share the credentials with viewers — once a relay is pushed, everyone watching your room gets it automatically.",
} as const;

const ptBR: Record<keyof typeof en, string> = {
  signIn: "Entrar",
  signOut: "Sair",
  settings: "Configurações",
  myAccount: "Minha conta",
  toggleTheme: "Alternar tema",
  light: "Claro",
  dark: "Escuro",
  system: "Sistema",
  selectLanguage: "Selecionar idioma",
  inviteOnly: "somente convite · gratuito · login com discord",
  homeTagline:
    "Transmita sua tela ao vivo — até 1080p 60fps — apenas com um código de sala. Sem downloads, sem contas além do Discord. Quem abre a página vê o stream tocar sozinho.",
  startStreaming: "Começar a transmitir",
  startStreamingDesc: "Crie uma sala, escolha uma tela ou janela e compartilhe o link.",
  goToStudio: "Ir para o estúdio",
  watchAStream: "Assistir a um stream",
  watchAStreamDesc:
    "Entre em uma sala pelo código. Se ninguém estiver ao vivo ainda, a transmissão começa automaticamente quando alguém entrar.",
  roomCodePlaceholder: "Código da sala, ex.: 83jkf",
  join: "Entrar",
  welcomeToGoLive: "Bem-vindo ao GoLive",
  discordOnlySignIn: "Compartilhe sua tela com amigos. O Discord é a única forma de entrar.",
  redirectingToDiscord: "Redirecionando para o Discord...",
  continueWithDiscord: "Continuar com o Discord",
  welcomeBack: "Bem-vindo de volta",
  welcomeBackDesc:
    "{name}. Crie uma sala para transmitir ou entre em uma que alguém compartilhou com você.",
  startATransmission: "Iniciar uma transmissão",
  startATransmissionDesc:
    "Crie uma sala e você receberá um código curto. Qualquer pessoa com o link pode assistir — só precisa de uma conta Discord.",
  titleLabel: "Título",
  titlePlaceholder: "ex.: Partidas de fim de semana",
  creating: "Criando…",
  createRoomAndOpenStudio: "Criar sala e abrir estúdio",
  createTransmissionFailed: "Falha ao criar a transmissão",
  roomCode: "Código da sala",
  roomCodeHint: "Os códigos de sala não diferenciam maiúsculas de minúsculas — não é preciso digitar o “#”.",
  settingsDesc:
    "As chaves de API de webhook permitem enviar seu próprio relay TURN. As credenciais ficam na memória até expirarem — nada é persistido.",
  activeTurnRelay: "Relay TURN ativo",
  refresh: "Atualizar",
  state: "Estado",
  expired: "Expirado",
  fresh: "Novo",
  username: "Usuário",
  pushed: "Enviado",
  expires: "Expira",
  sourceKey: "Chave de origem",
  noRelayConfig:
    "Nenhuma configuração de relay. Crie uma chave e envie seu servidor TURN para obter conexões retransmitidas.",
  testConnection: "Testar conexão",
  webhookApiKeys: "Chaves de API de webhook",
  newKey: "Nova chave",
  keyNamePlaceholder: "ex.: Meu coturn",
  create: "Criar",
  revoked: "Revogada",
  revoke: "Revogar",
  keyCreatedCopySecret: "Chave criada — copie o segredo agora",
  keyId: "ID da chave (X-Turn-Key)",
  secret: "Segredo",
  copy: "Copiar",
  secretShownOnce:
    "Este segredo é mostrado apenas uma vez. Com ele você assina as requisições de webhook (HMAC sobre o timestamp). Se você o perder, revogue a chave e crie uma nova.",
  copyCurlExample: "Copiar exemplo de curl",
  deleteConfirm: "Excluir esta chave de API? Ela não poderá mais ser usada.",
  createKeyFailed: "Falha ao criar a chave",
  revokeKeyFailed: "Falha ao revogar a chave",
  deleteKeyFailed: "Falha ao excluir a chave",
  copied: "Copiado",
  relayUrlReturned: "{count} URL de relay retornada",
  relayUrlsReturned: "{count} URLs de relay retornadas",
  noRelayConfigured:
    "Nenhum relay configurado ou ele expirou — os clientes conectarão apenas diretamente",
  testFailed: "Teste falhou: {message}",
  never: "nunca",
  secondsAgo: "há {s}s",
  minutesAgo: "há {m}m",
  hoursAgo: "há {h}h",
  createdUsed: "Criada {created} · Usada {used}",
  roomNotFound: "Sala não encontrada",
  couldNotLoadRoom: "Não foi possível carregar esta sala",
  checkRoomCode: "Verifique o código da sala que você recebeu e tente novamente.",
  notTheHost: "Você não é o anfitrião desta sala",
  watchInstead: "Assistir em vez disso",
  transmission: "Transmissão",
  broadcastStudio: "Estúdio de transmissão",
  live: "AO VIVO",
  viewer: "espectador",
  viewers: "espectadores",
  copyLink: "Copiar link",
  endStream: "Encerrar stream",
  waitingForPicker: "Aguardando o seletor…",
  goLive: "Ir ao vivo",
  screenShareCancelled: "O compartilhamento de tela foi cancelado",
  couldNotStartScreenShare: "Não foi possível iniciar o compartilhamento de tela",
  readyWhenYouAre: "Pronto quando você estiver",
  goLivePickerDesc:
    "Pressione Ir ao vivo, escolha uma tela ou janela e até {res} de vídeo será enviado a todos nesta sala.",
  streamQuality: "Qualidade do stream",
  qualityLow: "Baixa",
  qualityMedium: "Média",
  qualityHigh: "Alta",
  shareUrl: "Compartilhe {url}",
  broadcastingFooter:
    "Você está transmitindo para todos na sala #{code}. Encerrar o stream (ou fechar o seletor de compartilhamento) interrompe a transmissão para todos os espectadores.",
  roomReadyFooter:
    "A sala está pronta. Quem abrir seu link esperará aqui e seu stream começará automaticamente no momento em que você for ao vivo.",
  share: "Compartilhar",
  reconnecting: "Reconectando…",
  connecting: "Conectando…",
  streamOffline: "O stream está offline",
  hostNotStarted: "{name} ainda não começou. ",
  hostNotStartedGeneric: "O anfitrião ainda não começou. ",
  willPlayHere: "Ele tocará aqui automaticamente assim que começarem.",
  watchingRoomChanges: "Assistindo a esta sala por mudanças…",
  clickToUnmute: "Clique para ativar o som",
  unmute: "Ativar som",
  mute: "Silenciar",
  thisStream: "este stream",
  watchingStart: "Assistindo a",
  with: "com",
  inviteMore: "Compartilhe a sala #{code} para convidar mais pessoas.",
  roomStaysOpen: "Esta sala permanece aberta — novos espectadores podem entrar a qualquer momento.",
  theHost: "o anfitrião",
  help: "Ajuda",
  helpTitle: "Não consegue ver o stream?",
  helpIntro:
    "O GoLive envia um stream de navegador para navegador (WebRTC). Algumas redes — proxies corporativos, roteadores restritos, algumas operadoras de celular — bloqueiam essa conexão direta, então o stream fica em “Conectando…” ou “Reconectando…” mesmo com o anfitrião ao vivo. Qualquer uma das opções abaixo resolve.",
  helpOption1Title: "Opção 1 · Envie seu próprio relay TURN",
  helpOption1Desc:
    "Um servidor TURN retransmite seu stream quando a conexão direta falha. Você envia o seu pela API de webhook.",
  helpStep1: "Abra Configurações e crie uma chave de API de webhook.",
  helpStep2:
    "Execute o comando curl gerado com o endereço, usuário e senha do seu servidor TURN. O segredo assina cada requisição e é mostrado apenas uma vez.",
  helpStep3:
    "Envie novamente antes de expirar. As credenciais ficam na memória e expiram após o TTL (1 hora por padrão, até 24h), então reenvie-as — por exemplo, com um cron — para manter o relay ativo.",
  helpTestTitle: "Verifique se funciona",
  helpTestDesc:
    "Use Configurações → Testar conexão — ele mostra quantas URLs de relay estão sendo retornadas.",
  helpSettingsButton: "Abrir Configurações",
  helpOption2Title: "Opção 2 · Use o Tailscale",
  helpOption2Desc:
    "Instale o Tailscale na máquina do anfitrião e em qualquer espectador que não consiga conectar, conectando todos os dispositivos na mesma tailnet. O stream passa a trafegar pela sua rede privada do Tailscale, que atravessa a maioria dos NATs restritivos — sem precisar de webhook.",
  helpNote:
    "Você nunca compartilha as credenciais com os espectadores — assim que um relay é enviado, todos que assistem à sua sala o recebem automaticamente.",
};

export type MessageKey = keyof typeof en;

type Params = Record<string, string | number>;

const STORAGE_KEY = "golive.locale";

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "pt-BR") {
      return stored;
    }
  } catch {
    // ignore storage access errors
  }
  return navigator.language.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const template = messages[locale][key];
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

export const messages: Record<Locale, Record<MessageKey, string>> = {
  en,
  "pt-BR": ptBR,
};

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Params) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore storage access errors
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);
  const t = useCallback(
    (key: MessageKey, params?: Params) => translate(locale, key, params),
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within a LocaleProvider");
  }
  return ctx;
}