import { t, type Locale, type MessageKey } from "./index";

const phases: Readonly<Partial<Record<string, MessageKey>>> = {
  planned: "phasePlanned",
  sent: "phaseSent",
  received: "phaseReceived",
  processing: "phaseProcessing",
  ready_for_return: "phaseReady",
  return_sent: "phaseReturnSent",
  returned: "phaseReturned",
  did_not_travel: "didNotTravel",
};

export function phaseLabel(locale: Locale, phase: string) {
  const key = Object.hasOwn(phases, phase) ? phases[phase] : undefined;
  return key ? t(locale, key) : phase;
}
