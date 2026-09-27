import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { KpiTile } from './KpiTile';

describe('KpiTile', () => {
  it('renders the formatted value, exposes the definition via an accessible tooltip and shows the data-quality note', async () => {
    render(
      <KpiTile
        metric={{ key: 'gmv', label: 'GMV', value: 125_000_000, unit: 'IDR', definition: 'Σ baris ITEM_PRICE transaksi COMPLETED dalam periode.', sampleSize: 12, dataQuality: 'Sampel kecil (n=12 < 30); jangan disimpulkan sebagai tren.' }}
      />,
    );
    expect(screen.getByText(/Rp\s125\.000\.000/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Sampel kecil (n=12 < 30)');
    expect(screen.getByText('n = 12')).toBeInTheDocument();
    const info = screen.getByRole('button', { name: 'Definisi GMV' });
    const tip = document.getElementById(info.getAttribute('aria-describedby')!)!;
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip).toHaveTextContent('Σ baris ITEM_PRICE transaksi COMPLETED dalam periode.');
    expect(tip).not.toBeVisible();
    await userEvent.tab();
    expect(info).toHaveFocus();
    expect(tip).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(tip).not.toBeVisible();
  });

  it('formats ratios as percent and omits the note for decision-grade samples', () => {
    render(<KpiTile metric={{ key: 'takeRate', label: 'Take rate', value: 0.0725, unit: 'RATIO', definition: 'Pendapatan ÷ GMV.', sampleSize: 420, dataQuality: null }} />);
    expect(screen.getByText(/7,25\s%/)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Take rate/ })).toBeInTheDocument();
  });

  it('shows an em dash for missing values instead of a fake zero', () => {
    render(<KpiTile metric={{ key: 'disputeRate', label: 'Dispute rate', value: null, unit: 'RATIO', definition: 'x', sampleSize: 0, dataQuality: 'Belum ada data pada periode ini.' }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Belum ada data');
  });
});
