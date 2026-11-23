"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { requestCode, verifyCode } from "./sign-in-actions";

export function SignIn({ accounts }: { accounts: { name: string; phone: string }[] }) {
  const demo = accounts.length > 0;
  const [phone, setPhone] = useState(accounts[0]?.phone ?? "");
  const [accessCode, setAccessCode] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [enterCode, setEnterCode] = useState(false);
  const [code, setCode] = useState("");
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
    if (!demo) listenForText();
    start(async () => {
      try {
        const result = await requestCode(phone, demo ? accessCode : undefined);
        if (result.error !== undefined) {
          listener.current?.abort();
          setMessage(result.error);
          return;
        }
        setEnterCode(true);
        setSeconds(result.retrySeconds);
        if (result.limited) setMessage("Please wait before requesting another code.");
        else if (demo) {
          setDemoCode(result.previewCode ?? "");
          setMessage("Enter your demo code to continue.");
        }
        else {
          setMessage("If this number belongs to active staff, a code is on its way.");
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
    <h1>{enterCode ? (demo ? "Enter your demo code" : "Check your texts") : "Sign in"}</h1>
    {demo && <p>Preview test mode — SMS disabled. Use a demo account to try transfers with sample orders.</p>}
    {enterCode && demoCode && <p>Your demo code is <strong>{demoCode}</strong>.</p>}
    <form onSubmit={event => { event.preventDefault(); if (enterCode) verify(); else send(); }}>
      {enterCode ? <>
        <label htmlFor="otp">One-time code</label>
        <div className="otp">
          <input ref={input} id="otp" type="text" inputMode="numeric" autoComplete="one-time-code"
            maxLength={6} pattern="[0-9]{6}" value={code} required
            onChange={event => setCode(event.target.value.replace(/\D/g, ""))} />
          <div className="slots" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => <span key={i} data-current={i === Math.min(code.length, 5)}>{code[i]}</span>)}
          </div>
        </div>
      </> : demo ? <>
        <label htmlFor="account">Demo account</label>
        <select id="account" value={phone} onChange={event => setPhone(event.target.value)}>
          {accounts.map(account => <option key={account.phone} value={account.phone}>{account.name}</option>)}
        </select>
        <label htmlFor="preview-access">Preview access code</label>
        <input id="preview-access" type="password" required autoComplete="off" maxLength={1024}
          value={accessCode} onChange={event => setAccessCode(event.target.value)} />
      </> : <>
        <label htmlFor="phone">Mobile number</label>
        <input id="phone" type="tel" autoComplete="tel" placeholder="(212) 555-0142" required
          maxLength={40} value={phone} onChange={event => setPhone(event.target.value)} />
      </>}
      <button className="primary" disabled={pending}>{enterCode ? "Continue" : demo ? "Get demo code" : "Send code"}</button>
    </form>
    <p role="status">{message}</p>
    {enterCode && <>
      <button className="link" disabled={pending || seconds > 0} onClick={send}>
        {seconds > 0 ? `Resend in ${seconds}s` : "Resend code"}
      </button>
      <button className="link" disabled={pending} onClick={() => {
        listener.current?.abort();
        setEnterCode(false); setDemoCode(""); setCode(""); setMessage(""); setSeconds(0);
      }}>{demo ? "Use a different account" : "Use a different number"}</button>
    </>}
  </>;
}
