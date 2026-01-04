import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhoopClient } from "../whoop-client";

export function registerHistoryTools(
  server: McpServer,
  whoopClient: WhoopClient
) {
  server.registerTool(
    "whoop_get_history",
    {
      title: "Get Whoop Historical Data",
      description:
        "Get historical Whoop data for multiple days including recovery scores, strain, sleep hours, and HRV trends. Useful for pattern analysis and tracking progress over time.",
      inputSchema: {
        days: z
          .number()
          .min(1)
          .max(90)
          .default(30)
          .describe("Number of days of history to fetch (1-90, default 30)"),
        endDate: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (defaults to yesterday to ensure complete data)"
          ),
      },
      outputSchema: {
        summary: z.object({
          totalDays: z.number(),
          daysWithData: z.number(),
          dateRange: z.object({
            start: z.string(),
            end: z.string(),
          }),
        }),
        averages: z.object({
          recoveryScore: z.number().nullable(),
          strain: z.number().nullable(),
          sleepHours: z.number().nullable(),
          hrv: z.number().nullable(),
          restingHeartRate: z.number().nullable(),
        }),
        dailyData: z.array(
          z.object({
            date: z.string(),
            recoveryScore: z.number().nullable(),
            strain: z.number().nullable(),
            sleepHours: z.number().nullable(),
            calories: z.number().nullable(),
          })
        ),
        weekdayPatterns: z.object({
          bestRecoveryDay: z.string().nullable(),
          worstRecoveryDay: z.string().nullable(),
          avgByDay: z.record(z.string(), z.number()),
        }),
        trends: z.object({
          recoveryTrend: z.string(),
          strainTrend: z.string(),
          sleepTrend: z.string(),
        }),
      },
    },
    async ({ days = 30, endDate }) => {
      try {
        const end = endDate
          ? new Date(endDate)
          : new Date(Date.now() - 24 * 60 * 60 * 1000); // Yesterday
        const start = new Date(end);
        start.setDate(start.getDate() - days + 1);

        const dailyData: any[] = [];
        const weekdayTotals: Record<string, { sum: number; count: number }> = {
          Sunday: { sum: 0, count: 0 },
          Monday: { sum: 0, count: 0 },
          Tuesday: { sum: 0, count: 0 },
          Wednesday: { sum: 0, count: 0 },
          Thursday: { sum: 0, count: 0 },
          Friday: { sum: 0, count: 0 },
          Saturday: { sum: 0, count: 0 },
        };

        const weekdays = [
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ];

        // Fetch data for each day
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split("T")[0] ?? "";
          try {
            const data = await whoopClient.getHomeData(dateStr);
            const live = data.metadata?.whoop_live_metadata;

            if (live) {
              const dayData = {
                date: dateStr,
                recoveryScore: live.recovery_score ?? null,
                strain: live.day_strain ?? null,
                sleepHours: live.ms_of_sleep
                  ? live.ms_of_sleep / (1000 * 60 * 60)
                  : null,
                calories: live.calories ?? null,
              };
              dailyData.push(dayData);

              // Track weekday patterns
              const dayOfWeek = weekdays[new Date(dateStr).getDay()] as string;
              if (live.recovery_score != null && dayOfWeek && weekdayTotals[dayOfWeek]) {
                weekdayTotals[dayOfWeek].sum += live.recovery_score;
                weekdayTotals[dayOfWeek].count += 1;
              }
            }
          } catch (err) {
            // Skip days with errors, continue fetching
            dailyData.push({
              date: dateStr,
              recoveryScore: null,
              strain: null,
              sleepHours: null,
              calories: null,
            });
          }

          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Calculate averages
        const validRecovery = dailyData.filter((d) => d.recoveryScore != null);
        const validStrain = dailyData.filter((d) => d.strain != null);
        const validSleep = dailyData.filter((d) => d.sleepHours != null);

        const averages = {
          recoveryScore:
            validRecovery.length > 0
              ? Math.round(
                  validRecovery.reduce((a, b) => a + b.recoveryScore, 0) /
                    validRecovery.length
                )
              : null,
          strain:
            validStrain.length > 0
              ? Math.round(
                  (validStrain.reduce((a, b) => a + b.strain, 0) /
                    validStrain.length) *
                    10
                ) / 10
              : null,
          sleepHours:
            validSleep.length > 0
              ? Math.round(
                  (validSleep.reduce((a, b) => a + b.sleepHours, 0) /
                    validSleep.length) *
                    10
                ) / 10
              : null,
          hrv: null, // Would need deep dive data for each day
          restingHeartRate: null,
        };

        // Calculate weekday averages
        const avgByDay: Record<string, number> = {};
        let bestDay: string | null = null;
        let worstDay: string | null = null;
        let bestAvg = -1;
        let worstAvg = 101;

        for (const [day, data] of Object.entries(weekdayTotals)) {
          if (data.count > 0) {
            const avg = Math.round(data.sum / data.count);
            avgByDay[day] = avg;
            if (avg > bestAvg) {
              bestAvg = avg;
              bestDay = day;
            }
            if (avg < worstAvg) {
              worstAvg = avg;
              worstDay = day;
            }
          }
        }

        // Calculate trends (comparing first half vs second half)
        const midpoint = Math.floor(dailyData.length / 2);
        const firstHalf = dailyData.slice(0, midpoint);
        const secondHalf = dailyData.slice(midpoint);

        const calcAvg = (arr: any[], key: string) => {
          const valid = arr.filter((d) => d[key] != null);
          return valid.length > 0
            ? valid.reduce((a, b) => a + b[key], 0) / valid.length
            : null;
        };

        const getTrend = (first: number | null, second: number | null) => {
          if (first == null || second == null) return "insufficient data";
          const diff = ((second - first) / first) * 100;
          if (diff > 5) return "improving";
          if (diff < -5) return "declining";
          return "stable";
        };

        const trends = {
          recoveryTrend: getTrend(
            calcAvg(firstHalf, "recoveryScore"),
            calcAvg(secondHalf, "recoveryScore")
          ),
          strainTrend: getTrend(
            calcAvg(firstHalf, "strain"),
            calcAvg(secondHalf, "strain")
          ),
          sleepTrend: getTrend(
            calcAvg(firstHalf, "sleepHours"),
            calcAvg(secondHalf, "sleepHours")
          ),
        };

        const output = {
          summary: {
            totalDays: days,
            daysWithData: validRecovery.length,
            dateRange: {
              start: start.toISOString().split("T")[0],
              end: end.toISOString().split("T")[0],
            },
          },
          averages,
          dailyData,
          weekdayPatterns: {
            bestRecoveryDay: bestDay,
            worstRecoveryDay: worstDay,
            avgByDay,
          },
          trends,
        };

        // Format text output
        const lines = [
          "📊 WHOOP HISTORICAL DATA",
          "════════════════════════",
          "",
          `📅 Date Range: ${output.summary.dateRange.start} to ${output.summary.dateRange.end}`,
          `📈 Days with data: ${output.summary.daysWithData}/${output.summary.totalDays}`,
          "",
          "📉 AVERAGES",
          "───────────",
          `  Recovery: ${averages.recoveryScore ?? "N/A"}%`,
          `  Strain: ${averages.strain ?? "N/A"}`,
          `  Sleep: ${averages.sleepHours ?? "N/A"} hours`,
          "",
          "📅 WEEKDAY PATTERNS",
          "───────────────────",
          `  Best recovery day: ${bestDay ?? "N/A"} (${bestAvg > 0 ? bestAvg + "%" : "N/A"})`,
          `  Worst recovery day: ${worstDay ?? "N/A"} (${worstAvg < 101 ? worstAvg + "%" : "N/A"})`,
          "",
        ];

        if (Object.keys(avgByDay).length > 0) {
          lines.push("  By day:");
          for (const [day, avg] of Object.entries(avgByDay)) {
            lines.push(`    ${day}: ${avg}%`);
          }
          lines.push("");
        }

        lines.push(
          "📈 TRENDS (comparing first half vs second half)",
          "────────────────────────────────────────────────",
          `  Recovery: ${trends.recoveryTrend}`,
          `  Strain: ${trends.strainTrend}`,
          `  Sleep: ${trends.sleepTrend}`,
          ""
        );

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
              text: `Error fetching historical data: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
