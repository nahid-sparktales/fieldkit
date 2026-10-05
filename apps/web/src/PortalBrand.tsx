import type { CSSProperties, ReactNode } from "react";
import {
  contrast,
  readableText,
  type AppearanceConfig,
} from "../../../packages/platform/src/branding-contracts.js";
import "./branding.css";

export function brandStyle(config: AppearanceConfig): CSSProperties {
  return {
    "--accent": config.accentColor,
    "--accent-ink": readableText(config.accentColor),
    "--portal-background": config.backgroundColor,
    "--portal-ink": readableText(config.backgroundColor),
    "--portal-hero": config.heroColor,
    "--portal-hero-ink": readableText(config.heroColor),
    "--portal-link":
      contrast(config.accentColor, config.backgroundColor) >= 4.5
        ? config.accentColor
        : readableText(config.backgroundColor),
  } as CSSProperties;
}
export function PortalHeader({
  name,
  logoUrl,
  home,
  websiteUrl,
  children,
}: {
  name: string;
  logoUrl: string | null;
  home: string;
  websiteUrl: string;
  children?: ReactNode;
}) {
  return (
    <header className="portal-header">
      <a href={home} className="portal-identity">
        {logoUrl ? (
          <img className="portal-logo" src={logoUrl} alt={`${name} logo`} />
        ) : (
          <span className="portal-monogram" aria-hidden="true">
            {name[0]}
          </span>
        )}
        <span>
          {name}
          <small>Help center</small>
        </span>
      </a>
      <div className="portal-header-actions">
        {websiteUrl && (
          <a href={websiteUrl} target="_blank" rel="noreferrer">
            Visit website ↗
          </a>
        )}
        {children}
      </div>
    </header>
  );
}
export function PortalHero({
  config,
  children,
}: {
  config: AppearanceConfig;
  children?: ReactNode;
}) {
  return (
    <div className="portal-hero">
      <span className="eyebrow">HERE TO HELP</span>
      <h1>{config.greeting}</h1>
      {config.description && <p>{config.description}</p>}
      {children}
    </div>
  );
}
export function PortalFooter({ config }: { config: AppearanceConfig }) {
  return (
    <footer className="portal-footer">
      {config.footerText && <p>{config.footerText}</p>}
      <nav aria-label="Support links">
        {config.privacyUrl && (
          <a href={config.privacyUrl} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        )}
        {config.termsUrl && (
          <a href={config.termsUrl} target="_blank" rel="noreferrer">
            Terms of service
          </a>
        )}
        <span>
          Powered by{" "}
          <a
            href="https://github.com/nahid-sparktales/fieldkit"
            target="_blank"
            rel="noreferrer"
          >
            Navigated Support
          </a>
        </span>
      </nav>
    </footer>
  );
}
