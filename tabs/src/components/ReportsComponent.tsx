import React, { FunctionComponent, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './ReportsComponent.module.css';
import { acquireIdToken } from '../services/adminRole';
import { getReports, ReportsData } from '../services/reportsService';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);

const BarChart: FunctionComponent<{ series: number[] }> = ({ series }) => {
  const max = Math.max(...series, 1);
  const barWidth = 40;
  const gap = 12;
  const width = series.length * (barWidth + gap);
  return (
    <svg viewBox={`0 0 ${width} 120`} className={styles.chart} role="img">
      <line x1="0" y1="119" x2={width} y2="119" stroke="#3a383a" strokeWidth="1.5" />
      {series.map((sats, i) => {
        const height = Math.max(sats > 0 ? 6 : 2, (sats / max) * 100);
        const x = i * (barWidth + gap) + gap / 2;
        return (
          <g key={i}>
            <rect
              x={x}
              y={117 - height}
              width={barWidth}
              height={height}
              rx={3}
              fill={sats > 0 ? '#84cc16' : '#3a383a'}
            >
              <title>{`${fmt(sats)} sats`}</title>
            </rect>
            {sats > 0 && (
              <text
                x={x + barWidth / 2}
                y={117 - height - 5}
                textAnchor="middle"
                className={styles.barLabel}
              >
                {fmt(sats)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

const ReportsComponent: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accounts[0]) {
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        const idToken = await acquireIdToken(instance, accounts[0]);
        setData(await getReports(idToken));
      } catch (error) {
        console.error('Error fetching reports:', error);
        toast.error('Could not load reports.');
      } finally {
        setLoading(false);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, instance]);

  if (loading) {
    return (
      <div className={styles.reportscomponent}>
        <p className={styles.subtitle}>Loading reports...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={styles.reportscomponent}>
        <p className={styles.subtitle}>Reports are unavailable right now.</p>
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className={styles.reportscomponent}>
      <h2 className={styles.title}>Reports</h2>
      <p className={styles.subtitle}>
        How recognition flows through the team, from peer zaps to automated rewards.
      </p>

      <div className={styles.summaryRow}>
        <div className={styles.summaryBlock}>
          <span className={styles.summaryValue}>
            {fmt(data.totalZapSats)}
            <span className={styles.summaryUnit}> sats</span>
          </span>
          <span className={styles.summaryLabel}>
            recognised peer to peer · {data.totalZapCount} zaps
          </span>
        </div>
        <div className={styles.summaryBlock}>
          <span className={styles.summaryValue}>
            {fmt(data.totalAutomatedSats)}
            <span className={styles.summaryUnit}> sats</span>
          </span>
          <span className={styles.summaryLabel}>
            paid by automations · {data.totalAutomatedCount} payments
          </span>
        </div>
      </div>

      <div className={styles.chartGrid}>
        <div className={styles.chartCard}>
          <span className={styles.chartTitle}>Peer recognition</span>
          <span className={styles.chartSubtitle}>
            Sats zapped between teammates · last {data.weeks} weeks
          </span>
          <BarChart series={data.zapsWeekly} />
        </div>
        <div className={styles.chartCard}>
          <span className={styles.chartTitle}>Automated payouts</span>
          <span className={styles.chartSubtitle}>
            Sats paid by the treasury · last {data.weeks} weeks
          </span>
          <BarChart series={data.automationWeekly} />
        </div>
      </div>

      <ToastContainer />
    </div>
  );
};

export default ReportsComponent;
