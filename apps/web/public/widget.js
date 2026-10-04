/* FieldKit loader. Customer identity is signed by the embedding application's server. */
(() => {
  const script = document.currentScript;
  if (!script?.dataset.workspace) return;
  const origin = new URL(script.src).origin,
    slug = encodeURIComponent(script.dataset.workspace);
  const root = document.createElement("div");
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML =
    "<style>:host{position:fixed;right:24px;bottom:24px;z-index:2147483000}button{border:0;border-radius:30px;padding:16px 22px;background:#146b57;color:white;font:600 15px system-ui;cursor:pointer;box-shadow:0 5px 25px #0002}iframe{display:none;position:absolute;bottom:68px;right:0;width:min(400px,calc(100vw - 32px));height:min(640px,calc(100dvh - 120px));border:1px solid #d8e4de;border-radius:20px;box-shadow:0 15px 70px #0003;background:white}</style>";
  const frame = document.createElement("iframe");
  frame.title = "Customer support";
  frame.src = `${origin}/widget/${slug}`;
  const button = document.createElement("button");
  button.textContent = "Need a hand?";
  button.setAttribute("aria-expanded", "false");
  fetch(`${origin}/v2/public/${slug}/widget/config`, { credentials: "omit" })
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      if (!config) return;
      if (/^#[0-9a-f]{6}$/i.test(config.brandColor))
        button.style.background = config.brandColor;
      if (/^#[0-9a-f]{6}$/i.test(config.brandTextColor))
        button.style.color = config.brandTextColor;
      frame.title = `${config.name} support`;
      document.body.append(root);
    })
    .catch(() => {});
  button.onclick = () => {
    const open = frame.style.display !== "block";
    frame.style.display = open ? "block" : "none";
    button.textContent = open ? "Close support" : "Need a hand?";
    button.setAttribute("aria-expanded", String(open));
    if (open) frame.focus();
  };
  shadow.append(frame, button);
  let identity = script.dataset.identity;
  window.addEventListener("message", (event) => {
    if (
      event.origin === origin &&
      event.source === frame.contentWindow &&
      event.data?.type === "fieldkit:close"
    ) {
      frame.style.display = "none";
      button.textContent = "Need a hand?";
      button.setAttribute("aria-expanded", "false");
      button.focus();
    }
    if (
      event.origin === origin &&
      event.source === frame.contentWindow &&
      event.data?.type === "fieldkit:ready" &&
      identity
    )
      frame.contentWindow.postMessage(
        { type: "fieldkit:identity", identity },
        origin,
      );
  });
  window.FieldKit = {
    identify(signedIdentity) {
      identity = signedIdentity;
      frame.contentWindow?.postMessage(
        { type: "fieldkit:identity", identity },
        origin,
      );
    },
    open() {
      frame.style.display = "block";
      button.setAttribute("aria-expanded", "true");
      button.textContent = "Close support";
    },
  };
})();
