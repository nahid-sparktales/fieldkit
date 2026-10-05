export function ReadinessLink({ ws }: { ws: string }) {
  return (
    <p>
      <a href={`/?workspace=${encodeURIComponent(ws)}&view=readiness`}>
        Check readiness →
      </a>{" "}
      · Configuration, verified access and next steps
    </p>
  );
}
