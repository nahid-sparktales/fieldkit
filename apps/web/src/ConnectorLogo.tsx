export function ConnectorLogo({ provider }: { provider: string }) {
  const name = provider.startsWith("stripe_") ? "stripe" : provider;
  return (
    <span className="provider-logo" aria-hidden="true">
      {name === "openai_compatible" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="3" width="18" height="7" rx="2" />
          <rect x="3" y="14" width="18" height="7" rx="2" />
          <path
            d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <img src={`/connectors/${name}.svg`} alt="" width="28" height="28" />
      )}
    </span>
  );
}
