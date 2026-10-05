import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Platform } from "../../packages/platform/src/platform.js";
import { accounts } from "./seed.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function launcher(
  app: Platform,
  ws: string,
  password: string,
  origin: string,
) {
  const base = app.config.FIELDKIT_URL;
  return createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403);
      res.end("Use the printed 127.0.0.1 address.");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' ${base}; frame-src ${base}; connect-src 'self' ${base}; img-src ${base} data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    if (req.method === "GET" && req.url === "/sandbox-mail.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `document.addEventListener("submit",async function(e){if(e.target.action!==location.origin+"/reply")return;e.preventDefault();const f=e.target,b=f.querySelector("button"),s=f.querySelector("[role=status]");b.disabled=true;s.textContent="Sending local reply…";try{const r=await fetch("/reply",{method:"POST",headers:{Accept:"application/json"},body:new URLSearchParams(new FormData(f))});if(!r.ok)throw new Error(await r.text());s.textContent="Reply received. Check the ticket in Navigated Support.";f.querySelector("textarea").value="";}catch(error){s.textContent=error.message;}finally{b.disabled=false;}});`,
      );
      return;
    }
    if (req.method === "POST" && req.url === "/reply") {
      if (req.headers.origin !== origin) {
        res.writeHead(403);
        res.end("Use the local reply form.");
        return;
      }
      try {
        let content = "";
        for await (const chunk of req) {
          content += chunk;
          if (content.length > 16000) throw new Error("Message is too long");
        }
        const form = new URLSearchParams(content),
          file = form.get("file") ?? "";
        if (!/^[0-9]+-[a-f0-9-]+\.json$/.test(file))
          throw new Error("Invalid captured message");
        const mail = JSON.parse(
          await readFile(join(app.config.FIELDKIT_DATA, "mail", file), "utf8"),
        );
        if (!mail.options?.replyTo)
          throw new Error("This message has no reply address");
        const connection = await app.db.connection(ws, "ticket_email");
        const result = await app.ticketEmail.receive(
          ws,
          `Basic ${Buffer.from(`fieldkit:${app.connections.secret(connection).webhookSecret}`).toString("base64")}`,
          {
            MessageID: randomUUID(),
            OriginalRecipient: mail.options.replyTo,
            FromFull: { Email: mail.to },
            TextBody: form.get("body") ?? "",
            StrippedTextReply: form.get("body") ?? "",
          },
        );
        if (result.status !== "received")
          throw new Error(
            "Reply was rejected. See Publish → Email support for details.",
          );
        if (req.headers.accept?.includes("application/json")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true }));
        } else {
          res.writeHead(303, { Location: "/#outbox" });
          res.end();
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end((e as Error).message);
      }
      return;
    }
    if (req.method !== "GET" || req.url !== "/") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      const receipts = await app.db.rows(
        "SELECT receipt,created_at FROM sandbox_receipts ORDER BY created_at DESC LIMIT 10",
      );
      const mailDirectory = join(app.config.FIELDKIT_DATA, "mail");
      const mail = await Promise.all(
        (await readdir(mailDirectory))
          .sort()
          .slice(-8)
          .reverse()
          .map(async (file) => ({
            ...JSON.parse(await readFile(join(mailDirectory, file), "utf8")),
            file,
          })),
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trail Supply — Navigated Support store sandbox</title><style>
*{box-sizing:border-box}body{margin:0;background:#faf9f3;color:#20372c;font:16px/1.6 system-ui,sans-serif}.notice{background:#205c45;color:white;padding:12px 24px;text-align:center;font-size:14px}main{max-width:1100px;margin:auto;padding:32px 24px 90px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}a{color:#205c45;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #bb6a13;outline-offset:5px}.eyebrow{font-size:12px;letter-spacing:.14em;font-weight:750;text-transform:uppercase;color:#54725e}h1{font-size:clamp(36px,6vw,64px);line-height:1.06;max-width:700px;margin:12px 0 22px;letter-spacing:-.04em}h2{font-size:24px;line-height:1.3;margin-top:0}h3{margin:0 0 8px}p{max-width:750px}.hero{padding:64px 0 40px}.buttons{display:flex;gap:12px;flex-wrap:wrap}.button{display:inline-block;background:#205c45;color:white;border:1px solid #205c45;border-radius:9px;padding:12px 20px;text-decoration:none;font-weight:650}.secondary{background:transparent;color:#205c45}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}section{margin-top:32px}.card{padding:24px;background:white;border:1px solid #dce4d8;border-radius:14px}.icon{font-size:42px;margin:8px 0 20px}.price{font-size:22px;font-weight:700}.muted{font-size:14px;color:#54725e}code{background:#edf2e8;padding:3px 6px;border-radius:5px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:12px;border-bottom:1px solid #e8ece4}li{margin:10px 0}summary{cursor:pointer;padding:8px 0;font-weight:650}.split{display:grid;grid-template-columns:1fr 1fr;gap:20px}.label{background:#edf2e8;padding:5px 10px;border-radius:30px;font-size:12px;font-weight:750}footer{padding-top:30px;font-size:14px;color:#54725e}@media(max-width:700px){.grid,.split{grid-template-columns:1fr}.hero{padding-top:38px}main{padding:22px 18px 90px}th,td{padding:9px}header{align-items:flex-start}}
</style></head><body><div class="notice">LOCAL SANDBOX · Scripted responses · Simulated payments · No model tokens or real orders</div><main><header><strong>△ Trail Supply</strong><a href="${base}/support/trail-supply" target="_blank" rel="noopener">Customer help center ↗</a></header><div class="hero"><div class="eyebrow">Your Navigated Support practice store</div><h1>Take your support agent for a test run.</h1><p>A fictional outdoor store with real Navigated Support conversations, documents, workflows, approvals, and customer accounts. All replies and billing data in this environment are local fixtures.</p><div class="buttons"><a class="button" href="${base}/?workspace=${ws}&view=inbox" target="_blank" rel="noopener">Open staff inbox ↗</a><a class="button secondary" href="${base}/support/trail-supply" target="_blank" rel="noopener">Try customer portal ↗</a></div></div>
<div class="grid"><article class="card"><div class="icon" aria-hidden="true">🎒</div><h3>Summit Daypack</h3><p>24-liter everyday pack with a padded laptop sleeve.</p><div class="price">$89 <span class="muted">fictional USD</span></div><p class="muted">Alex’s order: TS-1001. Paid, delivered, eligible for a simulated refund.</p></article><article class="card"><div class="icon" aria-hidden="true">🥤</div><h3>Trail Bottle</h3><p>750 ml insulated bottle, made for the daily trail.</p><div class="price">$29 <span class="muted">fictional USD</span></div><p class="muted">Sam’s starter ticket: damaged bottle. Practice a staff handoff.</p></article><article class="card"><div class="icon" aria-hidden="true">🏕️</div><h3>Trail Club</h3><p>Free standard shipping and early product access.</p><div class="price">$12 <span class="muted">/ month, simulated</span></div><p class="muted">Alex’s active membership. Try a period-end cancellation.</p></article></div>
<section class="card"><h2>Choose a role</h2><p>Use a private browser window for the customer while staying signed in as staff. Accounts on the same Navigated Support origin share a session.</p><div class="table-wrap"><table><thead><tr><th>Role</th><th>Email</th><th>Try this</th></tr></thead><tbody>${accounts.map((a) => `<tr><td>${escape(a.name)}</td><td><code>${a.email}</code></td><td>${a.role === "owner" ? "Branding, workflows, actions, approvals" : a.role === "agent" ? "Inbox, replies, human takeover" : a.email.startsWith("alex") ? "Refund, membership, ticket history" : "Separate customer history; no billing records"}</td></tr>`).join("")}</tbody></table></div><details><summary>Show the local sample account password</summary><p><code>${escape(password)}</code></p><p class="muted">Generated for this local sandbox only. If you change an account’s password, use the new one; restarting preserves your changes.</p></details></section>
<section class="split"><article class="card"><h2>A five-minute walkthrough</h2><ol><li>Sign in as the owner. Open the existing <strong>$20 refund</strong> ticket, review the proposed action, and approve it.</li><li>Open the customer portal in a private window as Alex. Ask <strong>“What is your return policy?”</strong> and inspect the citation.</li><li>Ask <strong>“Cancel my Trail Club membership”</strong>. Return to the inbox to approve or reject it.</li><li>Try <strong>“I need a human to review a damaged bottle”</strong>. Take over, add an internal note, and reply.</li><li>Change <strong>Publish → Appearance</strong>, then refresh the portal. Edit a workflow reply and save/publish it.</li></ol></article><article class="card"><h2>More things to explore</h2><ul><li>Use <strong>Need a hand?</strong> on this page to try the anonymous widget.</li><li>In <strong>Knowledge</strong>, inspect five public documents and the staff-only escalation guide; upload your own test document.</li><li>Run the prepared <strong>Test Lab</strong> suite with <strong>AI quality assessment off</strong>. The five cases exercise workflow rules without executing actions.</li><li>Submit customer feedback, inspect <strong>Analytics</strong>, and triage <strong>Knowledge → Gaps</strong>.</li></ul><p class="muted">Offline replies match words and quote retrieved text. They do not test language-model quality or follow custom AI instructions. AI judging, AI gap analysis, external imports, real providers, and script runners are unavailable here.</p></article></section>
<section class="card"><h2>Simulated payment receipts</h2><p class="muted">Refresh this page after approving an action. Receipts and application changes survive a restart.</p>${receipts.length ? receipts.map((r) => `<details><summary>${escape(r.receipt.object)} · ${escape(new Date(r.created_at).toLocaleString())}</summary><pre>${escape(JSON.stringify(r.receipt, null, 2))}</pre></details>`).join("") : "<p>No payments have been simulated yet. The starter refund is waiting for staff approval.</p>"}</section>
<section class="card" id="outbox"><h2>Local email outbox</h2><p class="muted">Ticket replies, verification, invitations, and recovery messages are captured here. Nothing is emailed. Only use fictional addresses in this sandbox.</p>${mail.map((m) => `<details><summary>${escape(m.subject)} — ${escape(m.to)}</summary><pre>${escape(m.text)}</pre>${m.options?.replyTo ? `<form action="/reply" method="post"><input type="hidden" name="file" value="${escape(m.file)}"><label>Simulate replying from ${escape(m.to)}<br><textarea name="body" rows="3" required maxlength="12000" style="width:100%;padding:12px"></textarea></label><button type="submit">Send local email reply</button><p role="status"></p></form>` : ""}</details>`).join("") || "<p>No messages yet.</p>"}</section>
<footer>Keep this environment on your own computer. Stop with Ctrl+C; restart with <code>npm run sandbox</code>. To erase only this sandbox and restore its sample data, stop it and run <code>npm run sandbox -- --reset</code>. Your regular installation stays separate.</footer></main><script src="/sandbox-mail.js" defer></script><script src="${base}/widget.js" data-workspace="trail-supply" defer></script></body></html>`);
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.end("Could not load the local sandbox. Check the terminal.");
    }
  });
}
