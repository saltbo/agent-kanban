import { createLogger } from "../logger.js";

const logger = createLogger("runtime-circuit-breaker");

export interface RuntimeCircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

type CircuitState = "closed" | "open" | "half-open";

interface RuntimeCircuit {
  state: CircuitState;
  openedAt?: number;
  resumeAt?: number;
  probeInFlight?: boolean;
  failuresByTask: Map<string, number>;
}

export class RuntimeCircuitBreaker {
  private circuits = new Map<string, RuntimeCircuit>();
  private failureThreshold: number;
  private cooldownMs: number;

  constructor(options: RuntimeCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30 * 60_000;
  }

  canDispatch(runtime: string): boolean {
    const circuit = this.circuits.get(runtime);
    if (!circuit) return true;
    if (circuit.state === "closed") return true;

    if (circuit.state === "half-open") {
      return !circuit.probeInFlight;
    }

    return (circuit.resumeAt ?? 0) <= Date.now();
  }

  tryAcquireDispatch(runtime: string): boolean {
    const circuit = this.circuits.get(runtime);
    if (!circuit || circuit.state === "closed") return true;

    if (circuit.state === "open") {
      if ((circuit.resumeAt ?? 0) > Date.now()) return false;
      circuit.state = "half-open";
      circuit.probeInFlight = false;
      logger.info(`Runtime "${runtime}" circuit cooldown elapsed — allowing one probe`);
    }

    if (circuit.probeInFlight) return false;
    circuit.probeInFlight = true;
    logger.info(`Runtime "${runtime}" circuit half-open — allowing one probe`);
    return true;
  }

  releaseDispatch(runtime: string): void {
    const circuit = this.circuits.get(runtime);
    if (!circuit || circuit.state !== "half-open" || !circuit.probeInFlight) return;
    circuit.probeInFlight = false;
    logger.warn(`Runtime "${runtime}" circuit half-open probe was not started — releasing probe`);
  }

  isRuntimePaused(runtime: string): boolean {
    return !this.canDispatch(runtime);
  }

  pauseResetAt(runtime: string): string | null {
    const circuit = this.circuits.get(runtime);
    if (!circuit || circuit.state !== "open" || !circuit.resumeAt) return null;
    return new Date(circuit.resumeAt).toISOString();
  }

  recordPreClaimFailure(runtime: string, taskId: string, reason: string): void {
    const circuit = this.getCircuit(runtime);

    if (circuit.state === "half-open") {
      this.open(runtime, circuit, `half-open probe failed for task ${taskId}: ${reason}`);
      return;
    }

    const failures = (circuit.failuresByTask.get(taskId) ?? 0) + 1;
    circuit.failuresByTask.set(taskId, failures);
    logger.warn(`Runtime "${runtime}" pre-claim failure ${failures}/${this.failureThreshold} for task ${taskId}: ${reason}`);

    if (failures >= this.failureThreshold) {
      this.open(runtime, circuit, `task ${taskId} failed to enter workflow ${failures} times: ${reason}`);
    }
  }

  recordWorkflowEntered(runtime: string): void {
    const circuit = this.circuits.get(runtime);
    if (!circuit) return;
    if (circuit.state === "closed") return;
    logger.info(`Runtime "${runtime}" circuit closed after successful workflow entry`);
    this.circuits.delete(runtime);
  }

  stop(): void {
    this.circuits.clear();
  }

  private getCircuit(runtime: string): RuntimeCircuit {
    let circuit = this.circuits.get(runtime);
    if (!circuit) {
      circuit = { state: "closed", failuresByTask: new Map() };
      this.circuits.set(runtime, circuit);
    }
    return circuit;
  }

  private open(runtime: string, circuit: RuntimeCircuit, reason: string): void {
    const resumeAt = Date.now() + this.cooldownMs;
    circuit.state = "open";
    circuit.openedAt = Date.now();
    circuit.resumeAt = resumeAt;
    circuit.probeInFlight = false;
    logger.warn(`Runtime "${runtime}" circuit opened — pausing dispatch until ${new Date(resumeAt).toISOString()}; reason: ${reason}`);
  }
}
