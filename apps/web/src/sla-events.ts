import { useEffect, useRef } from "react";
export function useSlaEvents(ws: string, reload: () => void) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const stream = new EventSource(`/v2/workspaces/${ws}/sla/events`);
    stream.onmessage = () => latest.current();
    return () => stream.close();
  }, [ws]);
}
