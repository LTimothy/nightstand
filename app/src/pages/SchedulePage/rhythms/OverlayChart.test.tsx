import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import OverlayChart, { type ChartDot } from './OverlayChart';

const plan = [{ x: 0, f: 82 }, { x: 240, f: 79 }];
const draw = (props: { dots?: ChartDot[]; ticks?: number[]; on?: string; endMin?: number }) => render(<OverlayChart
  endMin={ props.endMin ?? 480 }
  loF={ 60 }
  hiF={ 90 }
  plan={ plan }
  blocks={ [] }
  on={ props.on ?? '22:00' }
  format="fahrenheit"
  dots={ props.dots }
  ticks={ props.ticks }/>);

describe('the overlay chart', () => {
  it('draws a filled dot per vote and a hollow edge ring with its value', () => {
    const { container } = draw({ dots: [{ x: 120, f: 80, key: 'a' }, { x: 300, f: 60, key: 'b', edge: 'bottom', label: '65°F' }] });
    expect(container.querySelectorAll('[data-dot]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-edge="bottom"]')).toHaveLength(1);
    expect(screen.getByText('65°F')).toBeInTheDocument();
  });

  it('keeps an edge label inside the chart, below a top ring and above a bottom one', () => {
    draw({ dots: [{ x: 120, f: 99, key: 'a', edge: 'top', label: '+1' }, { x: 120, f: 50, key: 'b', edge: 'bottom', label: '-1' }] });
    expect(screen.getByText('+1')).toHaveAttribute('data-label-place', 'below');
    expect(screen.getByText('-1')).toHaveAttribute('data-label-place', 'above');
    expect(screen.getByText('+1')).toHaveStyle({ top: '50%' });
    expect(screen.getByText('-1')).toHaveStyle({ bottom: '50%' });
  });

  it('puts the label left of a ring in the right quarter and right of any other', () => {
    draw({ dots: [{ x: 400, f: 99, key: 'a', edge: 'top', label: 'late' }, { x: 120, f: 99, key: 'b', edge: 'top', label: 'early' }] });
    expect(screen.getByText('late')).toHaveAttribute('data-label-side', 'left');
    expect(screen.getByText('late')).toHaveStyle({ right: '12px' });
    expect(screen.getByText('early')).toHaveAttribute('data-label-side', 'right');
    expect(screen.getByText('early')).toHaveStyle({ left: '12px' });
  });

  it('labels the ticks it is given', () => {
    draw({ on: '20:00', endMin: 660, ticks: [0, 135, 660] });
    for (const text of ['8:00 PM', '10:15 PM', '7:00 AM']) expect(screen.getByText(text)).toBeInTheDocument();
  });
});
