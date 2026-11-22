"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StoreId } from "../db/eligible-orders";
import type { BatchChange } from "../transfer/commands";

function canCheck(command: BatchChange) {
  return (
    command.kind === "runAction" ||
    command.kind === "confirmContents" ||
    command.kind === "correctSentMembership"
  );
}

export function useBatchChange(staffId: string, origin: StoreId) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const prefix = `planned-batch:${staffId}:${origin}:`;

  const submit = useCallback(
    async (change?: BatchChange, checkOnly = false) => {
      if (pending.current) return;
      pending.current = true;
      let navigating = false;
      try {
        const outstanding = Object.keys(localStorage).find((item) => item.startsWith(prefix));
        if (change && outstanding) {
          setUncertain(true);
          setMessage("Check the pending change before starting another.");
          return;
        }
        const key = outstanding ?? prefix + crypto.randomUUID();
        const body = change
          ? JSON.stringify({ operationId: key.slice(prefix.length), ...change })
          : localStorage.getItem(key);
        if (!body) {
          setUncertain(false);
          setMessage("");
          return;
        }
        const command = JSON.parse(body);
        const autoCheck = canCheck(command);
        if (change) localStorage.setItem(key, body);
        setBusy(true);
        async function request(statusOnly: boolean) {
          const response = await fetch(statusOnly ? "/api/batches?check=1" : "/api/batches", {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: { "content-type": "application/json" },
            body,
          });
          if (response.status >= 500) throw new Error("Unconfirmed");
          return response;
        }
        let response: Response;
        try {
          response = await request(checkOnly);
        } catch (error) {
          if (!autoCheck || checkOnly) throw error;
          setUncertain(true);
          setMessage("Not confirmed yet, checking…");
          checkOnly = true;
          response = await request(true);
        }
        if (response.status === 202) {
          setUncertain(true);
          setMessage("Still unconfirmed. Retry to check and finish this change.");
          return;
        }
        if (response.status === 401) {
          // A status check can follow a committed write even when the initial response was lost.
          if (change && !checkOnly) localStorage.removeItem(key);
          navigating = true;
          window.location.replace("/");
          return;
        }
        const result = await response.json();
        localStorage.removeItem(key);
        setUncertain(false);
        if (!response.ok) {
          setMessage(result.error);
          return;
        }
        const params = new URLSearchParams({ store: origin });
        if (result.result.contents) params.set("contents", result.result.batchId);
        else if (result.result.sent) params.set("sent", result.result.batchId);
        else if (!result.result.cancelled) params.set("batch", result.result.batchId);
        if (result.replayed) params.set("saved", "again");
        navigating = true;
        window.location.replace((result.result.board ? "/board?" : "/orders?") + params);
      } catch {
        setUncertain(true);
        setMessage("Not confirmed yet. Retry to check this change.");
      } finally {
        if (!navigating) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [origin, prefix],
  );

  useEffect(() => {
    const recovery = window.setTimeout(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
      if (!key) return;
      setUncertain(true);
      const body = localStorage.getItem(key);
      const command = body && JSON.parse(body);
      if (command && canCheck(command)) {
        setMessage("Not confirmed yet, checking…");
        void submit(undefined, true);
      } else {
        setMessage("A previous batch change is unconfirmed. Checking it can finish the save.");
      }
    }, 0);
    return () => window.clearTimeout(recovery);
  }, [prefix, submit]);

  return { busy, message, setMessage, uncertain, submit };
}
