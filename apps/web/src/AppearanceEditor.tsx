import { useState } from "react";
import {
  Appearance,
  type AppearanceConfig,
  type AppearanceView,
} from "../../../packages/platform/src/branding-contracts.js";
import { api, useLoad } from "./request.js";
import { useAction } from "./useAction.js";
import { LoadingState, SettingsField as Field } from "./ui.js";
import {
  PortalHeader,
  PortalHero,
  PortalFooter,
  brandStyle,
} from "./PortalBrand.js";

export function AppearanceEditor({
  ws,
  name,
  slug,
}: {
  ws: string;
  name: string;
  slug: string;
}) {
  const load = useLoad(() => api(ws, "/appearance"), [ws]);
  if (load.error)
    return (
      <div className="alert" role="alert">
        {load.error}
        <button onClick={load.reload}>Try again</button>
      </div>
    );
  if (!load.data) return <LoadingState label="Loading appearance…" />;
  return (
    <AppearanceForm
      key={ws}
      ws={ws}
      name={name}
      slug={slug}
      initial={load.data}
    />
  );
}
function AppearanceForm({
  ws,
  name,
  slug,
  initial,
}: {
  ws: string;
  name: string;
  slug: string;
  initial: AppearanceView;
}) {
  const [saved, setSaved] = useState(initial),
    [config, setConfig] = useState(initial.config);
  const [logo, setLogo] = useState<{ data: string } | null | undefined>();
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl),
    [mobile, setMobile] = useState(false);
  const action = useAction();
  const dirty =
    logo !== undefined ||
    JSON.stringify(config) !== JSON.stringify(saved.config);
  const change = <K extends keyof AppearanceConfig>(
    key: K,
    value: AppearanceConfig[K],
  ) => {
    setConfig((old) => ({ ...old, [key]: value }));
    action.setSuccess("");
  };
  const accept = (value: AppearanceView) => {
    setSaved(value);
    setConfig(value.config);
    setLogo(undefined);
    setLogoUrl(value.logoUrl);
  };
  const brandName = config.brandName || name;
  return (
    <div className="appearance-editor">
      <div className="section-heading">
        <div>
          <h2>Make your help center yours</h2>
          <p className="muted">
            Preview your changes, then save. Published channels update when you
            save.
          </p>
        </div>
        <a href={`/support/${slug}`} target="_blank" rel="noreferrer">
          Open help center ↗
        </a>
      </div>
      {action.error && (
        <div className="alert" role="alert">
          {action.error}
        </div>
      )}
      {action.success && (
        <p className="success" role="status">
          {action.success}
        </p>
      )}
      <div className="appearance-layout">
        <form
          className="appearance-controls panel"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(
              async () =>
                accept(
                  await api(
                    ws,
                    "/appearance",
                    {
                      config: Appearance.parse(config),
                      revision: saved.revision,
                      ...(logo !== undefined ? { logo } : {}),
                    },
                    "PUT",
                  ),
                ),
              "Appearance saved. Your published channels now use this design.",
            );
          }}
        >
          <fieldset disabled={action.busy}>
            <legend>Brand identity</legend>
            <Field label="Help center name">
              <input
                value={config.brandName}
                maxLength={80}
                placeholder={name}
                onChange={(e) => change("brandName", e.target.value)}
              />
            </Field>
            <Field label="Upload logo">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void action.run(async () => {
                    if (file.size > 1024 * 1024)
                      throw new Error("Logo must be 1 MB or smaller.");
                    if (
                      !["image/png", "image/jpeg", "image/webp"].includes(
                        file.type,
                      )
                    )
                      throw new Error(
                        "Choose a PNG, JPEG, or static WebP image.",
                      );
                    const dataUrl = await new Promise<string>(
                      (resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result));
                        reader.onerror = () =>
                          reject(new Error("Could not read this image."));
                        reader.readAsDataURL(file);
                      },
                    );
                    const image = new Image();
                    image.src = dataUrl;
                    try {
                      await image.decode();
                    } catch {
                      throw new Error(
                        "This image could not be read. Choose another logo.",
                      );
                    }
                    if (image.naturalWidth > 2048 || image.naturalHeight > 2048)
                      throw new Error(
                        "Logo dimensions must be 2048 × 2048 pixels or smaller.",
                      );
                    setLogo({ data: dataUrl.split(",")[1] });
                    setLogoUrl(dataUrl);
                  });
                }}
              />
            </Field>
            <p className="field-hint">
              PNG, JPEG, or static WebP. Up to 1 MB and 2048 × 2048 pixels. A
              transparent PNG works well. Also used as your browser icon.
            </p>
            {logoUrl && (
              <div className="logo-upload-preview">
                <img src={logoUrl} alt="Logo preview" />
                <button
                  type="button"
                  onClick={() => {
                    setLogo(null);
                    setLogoUrl(null);
                    action.setSuccess("");
                  }}
                >
                  Remove logo
                </button>
              </div>
            )}
          </fieldset>
          <fieldset disabled={action.busy}>
            <legend>Colors</legend>
            <div className="appearance-presets" aria-label="Color presets">
              {[
                ["Forest", "#146b57", "#fcfdf9", "#eef4e8"],
                ["Ocean", "#2455a4", "#f7faff", "#eaf1ff"],
                ["Plum", "#773d86", "#fcf9fe", "#f4e9f8"],
                ["Midnight", "#b9c9ff", "#141c30", "#202e4b"],
              ].map(([label, accentColor, backgroundColor, heroColor]) => (
                <button
                  type="button"
                  key={label}
                  onClick={() => {
                    setConfig((old) => ({
                      ...old,
                      accentColor,
                      backgroundColor,
                      heroColor,
                    }));
                    action.setSuccess("");
                  }}
                >
                  <span style={{ background: accentColor }} />
                  {label}
                </button>
              ))}
            </div>
            <div className="appearance-colors">
              {(
                [
                  ["accentColor", "Accent color"],
                  ["backgroundColor", "Page background"],
                  ["heroColor", "Welcome background"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    type="color"
                    value={config[key]}
                    onChange={(e) => change(key, e.target.value)}
                  />
                  <small>{config[key]}</small>
                </Field>
              ))}
            </div>
            <p className="field-hint">
              Text and button labels automatically adapt for readable contrast.
            </p>
          </fieldset>
          <fieldset disabled={action.busy}>
            <legend>Welcome & content</legend>
            <Field label="Welcome heading">
              <input
                required
                maxLength={200}
                value={config.greeting}
                onChange={(e) => change("greeting", e.target.value)}
              />
            </Field>
            <Field label="Welcome description">
              <textarea
                rows={3}
                maxLength={500}
                value={config.description}
                onChange={(e) => change("description", e.target.value)}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.showArticles}
                onChange={(e) => change("showArticles", e.target.checked)}
              />
              Show articles and search on the help center
            </label>
            <p className="field-hint">
              Your agent can still use approved knowledge when the article list
              is hidden.
            </p>
          </fieldset>
          <fieldset disabled={action.busy}>
            <legend>Links & footer</legend>
            {(
              [
                ["websiteUrl", "Company website"],
                ["privacyUrl", "Privacy policy URL"],
                ["termsUrl", "Terms of service URL"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  type="url"
                  placeholder="https://example.com"
                  value={config[key]}
                  onChange={(e) => change(key, e.target.value)}
                />
              </Field>
            ))}
            <Field label="Footer text">
              <input
                maxLength={200}
                value={config.footerText}
                placeholder={`© ${new Date().getFullYear()} ${name}`}
                onChange={(e) => change("footerText", e.target.value)}
              />
            </Field>
          </fieldset>
          <div className="appearance-save">
            <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
            <div className="button-row">
              <button className="primary" disabled={action.busy || !dirty}>
                {action.busy ? "Working…" : "Save appearance"}
              </button>
              <button
                type="button"
                disabled={action.busy}
                onClick={() => {
                  if (dirty && !confirm("Discard unsaved appearance changes?"))
                    return;
                  void action.run(async () =>
                    accept(await api(ws, "/appearance")),
                  );
                }}
              >
                Reload saved
              </button>
            </div>
          </div>
        </form>
        <section
          className="appearance-preview"
          aria-label="Help center preview"
        >
          <div className="section-heading">
            <div>
              <strong>Live preview</strong>
              <p className="field-hint">
                Sample content · changes stay local until saved
              </p>
            </div>
            <div className="button-row">
              <button aria-pressed={!mobile} onClick={() => setMobile(false)}>
                Desktop
              </button>
              <button aria-pressed={mobile} onClick={() => setMobile(true)}>
                Mobile
              </button>
            </div>
          </div>
          <div className={`appearance-preview-frame${mobile ? " mobile" : ""}`}>
            <div
              className="portal-page branded-portal"
              style={brandStyle(config)}
              inert
            >
              <PortalHeader
                name={brandName}
                logoUrl={logoUrl}
                home={`/support/${slug}`}
                websiteUrl={config.websiteUrl}
              >
                <button>Sign in</button>
              </PortalHeader>
              <PortalHero config={config}>
                {config.showArticles && (
                  <input
                    aria-label="Preview article search"
                    placeholder="Search our help center…"
                    readOnly
                  />
                )}
              </PortalHero>
              <div className="portal-content">
                {config.showArticles && (
                  <section>
                    <h2>Browse our knowledge</h2>
                    <div className="article-grid">
                      {["Getting started", "Frequently asked questions"].map(
                        (title) => (
                          <article className="article-card" key={title}>
                            <h3>{title}</h3>
                            <p>Your published articles appear here.</p>
                            <span>Read article →</span>
                          </article>
                        ),
                      )}
                    </div>
                  </section>
                )}
                <section className="portal-chat">
                  <div className="section-heading">
                    <h2>Talk to {brandName}</h2>
                  </div>
                  <p className="appearance-preview-chat">
                    Ask a question or get help from the team.
                  </p>
                  <div className="appearance-preview-chat">
                    <button className="primary">Send message →</button>
                  </div>
                </section>
              </div>
              <PortalFooter config={config} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
