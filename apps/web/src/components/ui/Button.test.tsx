import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('defaults to type="button" so it never submits a surrounding form', () => {
    render(<Button>Close</Button>);
    expect(screen.getByRole('button', { name: 'Close' }).getAttribute('type')).toBe('button');
  });

  it('lets the caller request a submit button', () => {
    render(<Button type="submit">Start</Button>);
    expect(screen.getByRole('button', { name: 'Start' }).getAttribute('type')).toBe('submit');
  });

  it('keeps the variant and caller classes', () => {
    render(
      <Button variant="danger" className="extra">
        Delete
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Delete' }).className).toBe('btn btn-danger extra');
  });
});
