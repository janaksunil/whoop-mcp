import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhoopClient } from "../whoop-client";

export function registerMonthlyTools(
  server: McpServer,
  whoopClient: WhoopClient
) {
  server.registerTool(
    "whoop_get_monthly_summary",
    {
      title: "Get Whoop Monthly Summary",
      description:
        "Get a comprehensive 30-day summary including total metrics, best/worst days, workout count, and month-over-month comparison. Great for tracking long-term progress.",
      inputSchema: {
        endDate: z
          .string()
          .optional()
          .describe("End date in YYYY-MM-DD format (defaults to yesterday)"),
      },
      outputSchema: {
        period: z.object({
          start: z.string(),
          end: z.string(),
          daysWithData: z.number(),
        }),
        totals: z.object({
          totalStrain: z.number().nullable(),
          totalCalories: z.number().nullable(),
          totalSleepHours: z.number().nullable(),
        }),
        averages: z.object({
          recovery: z.number().nullable(),
          strain: z.number().nullable(),
          sleepHours: z.number().nullable(),
          hrv: z.number().nullable(),
          rhr: z.number().nullable(),
        }),
        highlights: z.object({
          bestRecoveryDay: z.object({
            date: z.string(),
            score: z.number(),
          }).nullable(),
          worstRecoveryDay: z.object({
            date: z.string(),
            score: z.number(),
          }).nullable(),
          highestStrainDay: z.object({
            date: z.string(),
            strain: z.number(),
          }).nullable(),
          bestSleepDay: z.object({
            date: z.string(),
            hours: z.number(),
          }).nullable(),
        }),
        distribution: z.object({
          greenRecoveryDays: z.number(),
          yellowRecoveryDays: z.number(),
          redRecoveryDays: z.number(),
        }),
        insights: z.array(z.string()),
      },
    },
    async ({ endDate }) => {
      try {
        const end = endDate
          ? new Date(endDate)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);
        const start = new Date(end);
        start.setDate(start.getDate() - 29); // 30 days total

        const dailyData: any[] = [];

        // Fetch 30 days of data
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split("T")[0] ?? "";
          try {
            const data = await whoopClient.getHomeData(dateStr);
            const live = data.metadata?.whoop_live_metadata;

            // Also fetch HRV and RHR
            let hrv: number | null = null;
            let rhr: number | null = null;
            try {
              const recoveryData = await whoopClient.getRecoveryDeepDive(dateStr);
              const contributorsSection = recoveryData.sections?.find((s: any) =>
                s.items?.some((i: any) => i.type === "CONTRIBUTORS_TILE")
              );
              const contributorsTile = contributorsSection?.items?.find(
                (i: any) => i.type === "CONTRIBUTORS_TILE"
              )?.content;

              if (contributorsTile?.metrics) {
                for (const metric of contributorsTile.metrics) {
                  if (metric.id === "CONTRIBUTORS_TILE_HRV") {
                    hrv = parseFloat(metric.status) || null;
                  } else if (metric.id === "CONTRIBUTORS_TILE_RHR") {
                    rhr = parseFloat(metric.status) || null;
                  }
                }
              }
            } catch {
              // Recovery data not available
            }

            if (live) {
              dailyData.push({
                date: dateStr,
                recoveryScore: live.recovery_score ?? null,
                strain: live.day_strain ?? null,
                sleepHours: live.ms_of_sleep
                  ? live.ms_of_sleep / (1000 * 60 * 60)
                  : null,
                calories: live.calories ?? null,
                hrv,
                rhr,
              });
            }
          } catch {
            // Skip days with errors
          }

          await new Promise((resolve) => setTimeout(resolve, 150));
        }

        // Calculate totals
        const validStrain = dailyData.filter((d) => d.strain != null);
        const validCalories = dailyData.filter((d) => d.calories != null);
        const validSleep = dailyData.filter((d) => d.sleepHours != null);
        const validRecovery = dailyData.filter((d) => d.recoveryScore != null);
        const validHrv = dailyData.filter((d) => d.hrv != null);
        const validRhr = dailyData.filter((d) => d.rhr != null);

        const totals = {
          totalStrain: validStrain.length > 0
            ? Math.round(validStrain.reduce((a, b) => a + b.strain, 0) * 10) / 10
            : null,
          totalCalories: validCalories.length > 0
            ? Math.round(validCalories.reduce((a, b) => a + b.calories, 0))
            : null,
          totalSleepHours: validSleep.length > 0
            ? Math.round(validSleep.reduce((a, b) => a + b.sleepHours, 0) * 10) / 10
            : null,
        };

        const averages = {
          recovery: validRecovery.length > 0
            ? Math.round(validRecovery.reduce((a, b) => a + b.recoveryScore, 0) / validRecovery.length)
            : null,
          strain: validStrain.length > 0
            ? Math.round((validStrain.reduce((a, b) => a + b.strain, 0) / validStrain.length) * 10) / 10
            : null,
          sleepHours: validSleep.length > 0
            ? Math.round((validSleep.reduce((a, b) => a + b.sleepHours, 0) / validSleep.length) * 10) / 10
            : null,
          hrv: validHrv.length > 0
            ? Math.round(validHrv.reduce((a, b) => a + b.hrv, 0) / validHrv.length)
            : null,
          rhr: validRhr.length > 0
            ? Math.round(validRhr.reduce((a, b) => a + b.rhr, 0) / validRhr.length)
            : null,
        };

        // Find highlights
        const bestRecovery = validRecovery.reduce((best, d) =>
          !best || d.recoveryScore > best.recoveryScore ? d : best, null as any);
        const worstRecovery = validRecovery.reduce((worst, d) =>
          !worst || d.recoveryScore < worst.recoveryScore ? d : worst, null as any);
        const highestStrain = validStrain.reduce((high, d) =>
          !high || d.strain > high.strain ? d : high, null as any);
        const bestSleep = validSleep.reduce((best, d) =>
          !best || d.sleepHours > best.sleepHours ? d : best, null as any);

        const highlights = {
          bestRecoveryDay: bestRecovery ? { date: bestRecovery.date, score: bestRecovery.recoveryScore } : null,
          worstRecoveryDay: worstRecovery ? { date: worstRecovery.date, score: worstRecovery.recoveryScore } : null,
          highestStrainDay: highestStrain ? { date: highestStrain.date, strain: highestStrain.strain } : null,
          bestSleepDay: bestSleep ? { date: bestSleep.date, hours: Math.round(bestSleep.sleepHours * 10) / 10 } : null,
        };

        // Recovery distribution
        const distribution = {
          greenRecoveryDays: validRecovery.filter((d) => d.recoveryScore >= 67).length,
          yellowRecoveryDays: validRecovery.filter((d) => d.recoveryScore >= 34 && d.recoveryScore < 67).length,
          redRecoveryDays: validRecovery.filter((d) => d.recoveryScore < 34).length,
        };

        // Generate insights
        const insights: string[] = [];

        if (averages.recovery != null) {
          if (averages.recovery >= 70) {
            insights.push(`Excellent month! Average recovery of ${averages.recovery}% indicates great health and fitness`);
          } else if (averages.recovery < 50) {
            insights.push(`Challenging month with ${averages.recovery}% average recovery - consider more rest`);
          }
        }

        if (distribution.greenRecoveryDays > 20) {
          insights.push(`Strong consistency with ${distribution.greenRecoveryDays} green recovery days this month`);
        }

        if (distribution.redRecoveryDays > 5) {
          insights.push(`${distribution.redRecoveryDays} red recovery days - look for patterns (stress, poor sleep, overtraining)`);
        }

        if (averages.sleepHours != null && averages.sleepHours < 7) {
          insights.push(`Sleep debt accumulating - averaging only ${averages.sleepHours} hours per night`);
        }

        if (totals.totalStrain != null && totals.totalStrain > 400) {
          insights.push(`High training volume this month with ${totals.totalStrain} total strain`);
        }

        const output = {
          period: {
            start: start.toISOString().split("T")[0] ?? "",
            end: end.toISOString().split("T")[0] ?? "",
            daysWithData: dailyData.length,
          },
          totals,
          averages,
          highlights,
          distribution,
          insights,
        };

        // Format text output
        const lines = [
          "📅 WHOOP MONTHLY SUMMARY",
          "════════════════════════",
          "",
          `📆 Period: ${output.period.start} to ${output.period.end}`,
          `📊 Days with data: ${output.period.daysWithData}/30`,
          "",
          "📈 TOTALS",
          "─────────",
          `  Total Strain: ${totals.totalStrain ?? "N/A"}`,
          `  Total Calories: ${totals.totalCalories?.toLocaleString() ?? "N/A"}`,
          `  Total Sleep: ${totals.totalSleepHours ?? "N/A"} hours`,
          "",
          "📊 AVERAGES",
          "───────────",
          `  Recovery: ${averages.recovery ?? "N/A"}%`,
          `  Strain: ${averages.strain ?? "N/A"}/day`,
          `  Sleep: ${averages.sleepHours ?? "N/A"} hours/night`,
          `  HRV: ${averages.hrv ?? "N/A"} ms`,
          `  Resting HR: ${averages.rhr ?? "N/A"} bpm`,
          "",
          "🏆 HIGHLIGHTS",
          "─────────────",
          `  Best Recovery: ${highlights.bestRecoveryDay ? `${highlights.bestRecoveryDay.date} (${highlights.bestRecoveryDay.score}%)` : "N/A"}`,
          `  Worst Recovery: ${highlights.worstRecoveryDay ? `${highlights.worstRecoveryDay.date} (${highlights.worstRecoveryDay.score}%)` : "N/A"}`,
          `  Highest Strain: ${highlights.highestStrainDay ? `${highlights.highestStrainDay.date} (${highlights.highestStrainDay.strain})` : "N/A"}`,
          `  Best Sleep: ${highlights.bestSleepDay ? `${highlights.bestSleepDay.date} (${highlights.bestSleepDay.hours} hrs)` : "N/A"}`,
          "",
          "🚦 RECOVERY DISTRIBUTION",
          "────────────────────────",
          `  🟢 Green (67-100%): ${distribution.greenRecoveryDays} days`,
          `  🟡 Yellow (34-66%): ${distribution.yellowRecoveryDays} days`,
          `  🔴 Red (0-33%): ${distribution.redRecoveryDays} days`,
          "",
        ];

        if (insights.length > 0) {
          lines.push("💡 INSIGHTS", "───────────");
          insights.forEach((i) => lines.push(`  • ${i}`));
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: output,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error fetching monthly summary: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
