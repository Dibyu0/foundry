import { useEffect, useRef, useState } from 'react';
import type { PendingQuestion } from '../types';
import { useRovingTabindex } from '../a11y';

interface QuestionCardProps {
  question: PendingQuestion;
  busy: boolean;
  onAnswer: (answer: string) => void;
}

export function QuestionCard({ question, busy, onAnswer }: QuestionCardProps) {
  const [freeText, setFreeText] = useState('');
  const freeInputRef = useRef<HTMLInputElement>(null);
  const optionEls = useRef<(HTMLButtonElement | null)[]>([]);

  // Radio behavior: one option is checked at a time, arrow keys (plus
  // Home/End) move the check with focus, Enter/Space/click commits it.
  const { activeIndex, setActiveIndex, containerProps, getItemProps } = useRovingTabindex<HTMLButtonElement>(
    question.options.length,
    'vertical',
    { wrap: true },
  );

  // The card appears inside the chat feed; move focus into it so keyboard
  // and screen-reader users notice the build is waiting (A11Y_REVIEW #19).
  useEffect(() => {
    if (question.options.length > 0) optionEls.current[0]?.focus();
    else freeInputRef.current?.focus();
  }, [question.id, question.options.length]);

  function submitFreeText(e: React.FormEvent) {
    e.preventDefault();
    const text = freeText.trim();
    if (!text || busy) return;
    onAnswer(text);
    setFreeText('');
  }

  return (
    <section className="question-card" aria-label="Question from the team" aria-busy={busy}>
      <div className="q-kicker">The team asks</div>
      <p className="q-text">{question.text}</p>
      {question.options.length > 0 && (
        <div className="q-options" role="radiogroup" aria-label="Suggested answers" {...containerProps}>
          {question.options.map((opt, i) => {
            const item = getItemProps(i);
            const selected = i === activeIndex;
            return (
              <button
                key={opt.id ?? opt.label}
                ref={(el) => {
                  item.ref(el);
                  optionEls.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={item.tabIndex}
                onFocus={item.onFocus}
                className={`q-option${selected ? ' q-option--selected' : ''}`}
                disabled={busy}
                onClick={() => {
                  setActiveIndex(i);
                  onAnswer(opt.label);
                }}
              >
                <span className="q-option-radio" aria-hidden="true" />
                <span className="q-option-label">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
      <form className="q-freeform q-other" onSubmit={submitFreeText}>
        <input
          ref={freeInputRef}
          className="input q-other-input"
          type="text"
          placeholder="Or type your own answer..."
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          disabled={busy}
          aria-label="Your own answer"
        />
        <button type="submit" className="btn btn--primary btn--s q-other-send" disabled={busy || !freeText.trim()}>
          {busy ? 'Sending...' : 'Answer'}
        </button>
      </form>
    </section>
  );
}
