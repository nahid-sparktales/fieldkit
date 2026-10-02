import { useEffect, useState } from "react";
export async function request(
  path: string,
  data?: unknown,
  method?: string,
  bearer?: string,
) {
  const res = await fetch(path, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      ...(data instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok)
    throw new Error(result.error ?? "The request could not be completed");
  return result;
}
export const api = (
  ws: string,
  path: string,
  data?: unknown,
  method?: string,
  bearer?: string,
) => request(`/v2/workspaces/${ws}${path}`, data, method, bearer);
export function useLoad(fn: () => Promise<any>, keys: unknown[]) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    Promise.resolve()
      .then(fn)
      .then((v) => {
        if (live) setData(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [...keys, version]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}
