"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { requestCode, verifyCode } from "./sign-in-actions";

export function SignIn() {
  const [phone, setPhone] = useState("");
  const [enterCode, setEnterCode] = useState(false);
  const [code, setCode] = useState("");
  const [codeFocused, setCodeFocused] = useState(false);
  const [message, setMessage] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [pending, start] = useTransition();
  const listener = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => listener.current?.abort(), []);
  useEffect(() => { if (enterCode) input.current?.focus(); }, [enterCode]);
  useEffect(() => {
    if (!seconds) return;
    const timer = setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);

  function listenForText() {
    listener.current?.abort();
    if (!("OTPCredential" in window)) return;
    const controller = new AbortController();
    listener.current = controller;
    const options = { otp: { transport: ["sms"] }, signal: controller.signal };
    void navigator.credentials.get(options).then(credential => {
      if (!controller.signal.aborted && credential && "code" in credential && typeof credential.code === "string") {
        setCode(credential.code);
      }
    }).catch(() => { /* Manual entry stays available if WebOTP is dismissed. */ });
  }

  function send() {
    setMessage("");
    setCode("");
    listenForText();
    start(async () => {
      try {
        const result = await requestCode(phone);
        if (result.error !== undefined) {
          listener.current?.abort();
          setMessage(result.error);
          return;
        }
        setSeconds(result.retrySeconds);
        if (result.limited) {
          listener.current?.abort();
          setMessage("Please wait before requesting another code.");
        } else {
          setEnterCode(true);
        }
      } catch {
        listener.current?.abort();
        setMessage("Couldn’t request a code. Check your connection and try again.");
      }
    });
  }

  function verify() {
    start(async () => {
      try {
        const error = await verifyCode(phone, code);
        if (error) setMessage(error);
      } catch {
        setMessage("Couldn’t verify the code. Check your connection and try again.");
      }
    });
  }

  return <>
    <h1>{enterCode ? "Check your texts" : "Sign in"}</h1>
    <form onSubmit={event => { event.preventDefault(); if (enterCode) verify(); else send(); }}>
      {enterCode ? <>
        <label className="field-label" htmlFor="otp">One-time code</label>
        <div className="otp-wrap">
          <input ref={input} className="otp-real" id="otp" name="otp" type="text"
            inputMode="numeric" autoComplete="one-time-code" autoCapitalize="off" autoCorrect="off"
            spellCheck={false} minLength={6} maxLength={6} pattern="[0-9]*" value={code} required
            aria-describedby={message ? "sign-in-error" : undefined}
            onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)}
            onChange={event => setCode(event.target.value.replace(/\D/g, ""))} />
          <div className="otp-slots" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => {
              const active = codeFocused && i === Math.min(code.length, 5);
              return <span key={i} className={[code[i] && "is-filled", active && "is-active"].filter(Boolean).join(" ")}>{code[i]}</span>;
            })}
          </div>
        </div>
      </> : <>
        <label className="field-label" htmlFor="phone">Mobile number</label>
        <input className="tel-input" id="phone" name="phone" type="tel" inputMode="tel"
          autoComplete="tel" placeholder="(212) 555-0142" required maxLength={40}
          aria-describedby={message ? "sign-in-error" : undefined}
          value={phone} onChange={event => setPhone(event.target.value)} />
      </>}
      {message && <p className="field-error" id="sign-in-error" role="status">{message}</p>}
      <button className="btn" type="submit" disabled={pending}>{enterCode ? "Continue" : "Send code"}</button>
    </form>
    {enterCode && <>
      <p className="link-row">Didn’t get it?{" "}
        <button type="button" className="resend" disabled={pending || seconds > 0} onClick={send}>
          {seconds > 0 ? `Resend in ${seconds}s` : "Resend code"}
        </button>
      </p>
      <p className="link-row">
        <button type="button" className="resend" disabled={pending} onClick={() => {
          listener.current?.abort();
          setEnterCode(false); setCode(""); setMessage(""); setSeconds(0);
        }}>Use a different number</button>
      </p>
    </>}
  </>;
}
