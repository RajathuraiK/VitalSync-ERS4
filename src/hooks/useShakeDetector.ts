// ─────────────────────────────────────────────
//  useShakeDetector — Accelerometer Hook
//  • Gravity vector compensation
//  • Medium demonstration threshold (~10 m/s²)
//  • Stillness detection post-impact
//  • Built-in simulation for desktop/demo
// ─────────────────────────────────────────────
import { useEffect, useRef, useCallback, useState } from 'react';

export interface ShakeState {
  isShaking:        boolean;
  magnitude:        number;
  maxMagnitude:     number;
  isStill:          boolean;
  stillnessDuration: number; // seconds
  permissionGranted: boolean;
  requestPermission: () => Promise<boolean>;
  simulateShake:    (mag?: number, stillnessSec?: number) => void;
}

// ── Calibrated Demonstration Thresholds ───────
const SHAKE_THRESHOLD  = 9.5;   // m/s² — deliberate, medium-firm shake
const SHAKE_MIN_COUNT  = 2;     // consecutive readings to confirm shake
const STILL_THRESHOLD  = 1.8;   // m/s² — resting stillness after impact
const STILL_MIN_SEC    = 1.2;   // seconds of stillness to confirm post-shake state

export function useShakeDetector(
  onShake: (maxMagnitude: number) => void,
  onStillnessAfterShake: (duration: number) => void,
  enabled = true,
): ShakeState {
  const [state, setState] = useState<ShakeState>({
    isShaking: false,
    magnitude: 0,
    maxMagnitude: 0,
    isStill: false,
    stillnessDuration: 0,
    permissionGranted: false,
    requestPermission: async () => false,
    simulateShake: () => {},
  });

  const shakeCount        = useRef(0);
  const maxMag            = useRef(0);
  const hadShake          = useRef(false);
  const stillStart        = useRef<number | null>(null);
  const onShakeRef        = useRef(onShake);
  const onStillRef        = useRef(onStillnessAfterShake);
  const simTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);

  onShakeRef.current = onShake;
  onStillRef.current = onStillnessAfterShake;

  const requestPermission = useCallback(async (): Promise<boolean> => {
    // iOS 13+ requires explicit permission
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof (DeviceMotionEvent as any).requestPermission === 'function'
    ) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (DeviceMotionEvent as any).requestPermission();
        const granted = result === 'granted';
        setState(s => ({ ...s, permissionGranted: granted }));
        return granted;
      } catch {
        return false;
      }
    }
    // Android / desktop — no permission needed
    setState(s => ({ ...s, permissionGranted: true }));
    return true;
  }, []);

  // ── Simulator for Desktop / Demo ────────────
  const simulateShake = useCallback((mag = 14.5, stillnessSec = 2.0) => {
    if (simTimerRef.current) clearTimeout(simTimerRef.current);

    hadShake.current = true;
    maxMag.current = mag;

    // Step 1: Trigger active shake
    setState(s => ({
      ...s,
      isShaking: true,
      magnitude: mag,
      maxMagnitude: mag,
      isStill: false,
      stillnessDuration: 0,
    }));
    onShakeRef.current(mag);

    // Step 2: Settle into stillness after 800ms
    simTimerRef.current = setTimeout(() => {
      setState(s => ({
        ...s,
        isShaking: false,
        magnitude: 0.3,
        isStill: true,
        stillnessDuration: stillnessSec,
      }));
      onStillRef.current(stillnessSec);
    }, 800);
  }, []);

  useEffect(() => {
    setState(s => ({ ...s, requestPermission, simulateShake }));
  }, [requestPermission, simulateShake]);

  useEffect(() => {
    if (!enabled) return;

    const handleMotion = (e: DeviceMotionEvent) => {
      let mag = 0;

      // Prefer linear acceleration (pure motion excluding 9.8 m/s² gravity)
      if (e.acceleration && (e.acceleration.x !== null || e.acceleration.y !== null || e.acceleration.z !== null)) {
        const { x = 0, y = 0, z = 0 } = e.acceleration;
        mag = Math.sqrt((x ?? 0) ** 2 + (y ?? 0) ** 2 + (z ?? 0) ** 2);
      } else if (e.accelerationIncludingGravity) {
        // Fallback: subtract static gravity (9.8 m/s²)
        const { x = 0, y = 0, z = 0 } = e.accelerationIncludingGravity;
        const total = Math.sqrt((x ?? 0) ** 2 + (y ?? 0) ** 2 + (z ?? 0) ** 2);
        mag = Math.abs(total - 9.80665);
      }

      // ── Shake Detection ──────────────────
      if (mag >= SHAKE_THRESHOLD) {
        shakeCount.current += 1;
        if (mag > maxMag.current) maxMag.current = mag;

        if (shakeCount.current >= SHAKE_MIN_COUNT && !hadShake.current) {
          hadShake.current = true;
          stillStart.current = null;
          setState(s => ({
            ...s, isShaking: true, magnitude: mag, maxMagnitude: maxMag.current,
          }));
          onShakeRef.current(maxMag.current);
        }
      } else {
        shakeCount.current = Math.max(0, shakeCount.current - 1);
        if (shakeCount.current === 0 && state.isShaking) {
          setState(s => ({ ...s, isShaking: false }));
        }
      }

      // ── Stillness Detection (Post-Impact) ──
      if (hadShake.current && mag < STILL_THRESHOLD) {
        if (!stillStart.current) stillStart.current = Date.now();
        const secs = (Date.now() - stillStart.current) / 1000;
        setState(s => ({ ...s, isStill: true, stillnessDuration: secs, magnitude: mag }));
        if (secs >= STILL_MIN_SEC) {
          onStillRef.current(secs);
        }
      } else if (mag >= STILL_THRESHOLD) {
        if (state.isStill) setState(s => ({ ...s, isStill: false, stillnessDuration: 0 }));
        stillStart.current = null;
      }

      setState(s => ({ ...s, magnitude: mag }));
    };

    window.addEventListener('devicemotion', handleMotion, { passive: true });
    return () => {
      window.removeEventListener('devicemotion', handleMotion);
      if (simTimerRef.current) clearTimeout(simTimerRef.current);
    };
  }, [enabled, state.isShaking, state.isStill]);

  return state;
}
