'use client';

/**
 * A signature someone draws, rather than a name they type.
 *
 * The paper form has ΥΠΟΓΡΑΦΗ — a handwritten mark. Typing a name into a
 * box is not that: anyone can type anyone's name, and it looks like data
 * entry rather than signing. A drawn mark at least takes the deliberate
 * act the paper asks for.
 *
 * Honest about what it is NOT: this is not a cryptographic signature and
 * proves nothing about who held the phone. It is the same assurance the
 * paper gives — a mark someone made on purpose, kept with the record. The
 * real accountability lives in created_by / approved_by, which come from
 * the session, not from this canvas.
 *
 * ── The keyboard path ───────────────────────────────────────────────────
 *
 * Signing gates the save, and you cannot draw with a keyboard. So there is
 * a typed fallback, reachable by tab, and the value simply becomes text
 * instead of an image. Leaving it out would mean a keyboard-only user
 * could never file a sheet at all.
 *
 * ── Pointer events, not touch or mouse events ───────────────────────────
 *
 * One code path covers finger, stylus and mouse. Handling touch and mouse
 * separately is how you get a pad that works on a phone and not a laptop,
 * or double-fires on devices that emit both.
 */

import { useEffect, useRef, useState } from 'react';
import styles from './SignaturePad.module.css';

/** Drawn signatures are stored as this; anything else is a typed name. */
const PNG_PREFIX = 'data:image/png;base64,';

export function isDrawnSignature(value: string): boolean {
  return value.startsWith(PNG_PREFIX);
}

export default function SignaturePad({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);
  const [typing, setTyping] = useState(false);

  // A drawn value that did not come from this canvas — a restored draft, or
  // a correction — is shown as an image rather than redrawn, so the strokes
  // are never resampled and degraded.
  const showSaved = !typing && isDrawnSignature(value) && !dirtyRef.current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typing || showSaved) return;

    // Back the canvas at device resolution, or a signature drawn on a phone
    // is a blurry approximation of itself.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1d3e9c'; // the same ballpoint blue as every entry
  }, [typing, showSaved]);

  function positionOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    // Keeps strokes arriving even if the finger leaves the canvas mid-line.
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    dirtyRef.current = true;
    const { x, y } = positionOf(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = positionOf(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function end() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Committed on stroke end rather than on every move: re-encoding the
    // whole canvas per pointermove would stutter on a phone.
    onChange(canvas.toDataURL('image/png'));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    dirtyRef.current = false;
    onChange('');
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <span className={styles.label} id={`${id}-label`}>
          {label}
        </span>
        <button
          type="button"
          className={styles.switchMode}
          onClick={() => {
            setTyping((was) => !was);
            dirtyRef.current = false;
            onChange('');
          }}
        >
          {typing ? 'Υπογραφή με το δάχτυλο' : 'Πληκτρολόγηση αντί υπογραφής'}
        </button>
      </div>

      {typing ? (
        <input
          id={id}
          className={styles.typed}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-labelledby={`${id}-label`}
          autoComplete="off"
        />
      ) : showSaved ? (
        <div className={styles.savedWrap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt={label} className={styles.saved} />
          <button type="button" className={styles.clear} onClick={clear}>
            Ξανά
          </button>
        </div>
      ) : (
        <>
          <canvas
            id={id}
            ref={canvasRef}
            className={styles.canvas}
            aria-labelledby={`${id}-label`}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
          <div className={styles.footRow}>
            <span className={styles.hint}>Υπογράψτε μέσα στο πλαίσιο</span>
            <button type="button" className={styles.clear} onClick={clear}>
              Καθαρισμός
            </button>
          </div>
        </>
      )}
    </div>
  );
}
