import { useState } from 'react';
import type { PendingQuestion } from '../types';

interface QuestionCardProps {
  question: PendingQuestion;
  busy: boolean;
  onAnswer: (answer: string) => void;
}

export function QuestionCard({ question, busy, onAnswer }: QuestionCardProps) {
  const [freeText, setFreeText] = useState('');

  function submitFreeText(e: React.FormEvent) {
    e.preventDefault();
    const text = freeText.trim();
    if (!text || busy) return;
    onAnswer(text);
    setFreeText('');
  }

  return (
    <section className="question-card" aria-label="Question from the team">
      <div className="q-kicker">The team asks</div>
      <p className="q-text">{question.text}</p>
      {question.options.length > 0 && (
        <div className="q-options" role="group" aria-label="Suggested answers">
          {question.options.map((opt) => (
            <button
              key={opt.id ?? opt.label}
              type="button"
              className="q-option"
              disabled={busy}
              onClick={() => onAnswer(opt.label)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      <form className="q-freeform" onSubmit={submitFreeText}>
        <input
          className="input"
          type="text"
          placeholder="Or type your own answer…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          disabled={busy}
          aria-label="Your answer"
        />
        <button type="submit" className="btn btn--primary btn--s" disabled={busy || !freeText.trim()}>
          {busy ? 'Sending…' : 'Answer'}
        </button>
      </form>
    </section>
  );
}
