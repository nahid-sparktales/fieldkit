import { useEffect, useState } from "react";
export async function request(
  path: string,
  data?: unknown,
  method?: string,
  bearer?: string,
  customer = false,
) {
  const res = await fetch(path, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      ...(data instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(customer ? { "X-Fieldkit-Audience": "customer" } : {}),
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
  customer = false,
) => request(`/v2/workspaces/${ws}${path}`, data, method, bearer, customer);
export const customerApi = (
  ws: string,
  path: string,
  data?: unknown,
  method?: string,
  bearer?: string,
) => api(ws, path, data, method, bearer, true);
export function useLoad(fn: () => Promise<any>, keys: unknown[]) {
  const [result, setResult] = useState<{
      keys: unknown[];
      data: any;
      error: string;
      loading: boolean;
    }>({ keys, data: null, error: "", loading: true }),
    [version, setVersion] = useState(0);
  const sameKeys = (previous: unknown[]) =>
    previous.length === keys.length &&
    previous.every((key, index) => Object.is(key, keys[index]));
  useEffect(() => {
    let live = true;
    setResult((old) => ({
      keys,
      data: sameKeys(old.keys) ? old.data : null,
      error: "",
      loading: true,
    }));
    Promise.resolve()
      .then(fn)
      .then((v) => {
        if (live) setResult({ keys, data: v, error: "", loading: false });
      })
      .catch((e) => {
        if (live)
          setResult((old) => ({ ...old, error: e.message, loading: false }));
      });
    return () => {
      live = false;
    };
  }, [...keys, version]);
  const current = sameKeys(result.keys);
  return {
    data: current ? result.data : null,
    error: current ? result.error : "",
    loading: !current || result.loading,
    reload: () => setVersion((v) => v + 1),
  };
}
