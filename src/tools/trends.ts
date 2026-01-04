import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WhoopClient } from "../whoop-client";

export function registerTrendsTools(
  server: McpServer,
  whoopClient: WhoopClient
) {
  server.registerTool(
    "whoop_get_trends",
    {
      title: "Get Whoop Trends & Analytics",
      description:
        "Get trend analysis comparing recent performance to historical baselines. Compares last 7 days vs previous 7 days, and last 30 days overall patterns. Great for understanding if you're improving or need recovery.",
      inputSchema: {
        endDate: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (defaults to yesterday)"
          ),
      },
      outputSchema: {
        weekOverWeek: z.object({
          thisWeek: z.object({
            avgRecovery: z.number().nullable(),
            avgStrain: z.number().nullable(),
            avgSleep: z.number().nullable(),
            daysAbove70Recovery: z.number(),
          }),
          lastWeek: z.object({
            avgRecovery: z.number().nullable(),
            avgStrain: z.number().nullable(),
            avgSleep: z.number().nullable(),
            daysAbove70Recovery: z.number(),
          }),
          changes: z.object({
            recoveryChange: z.number().nullable(),
            strainChange: z.number().nullable(),
            sleepChange: z.number().nullable(),
          }),
        }),
        insights: z.array(z.string()),
        recommendations: z.array(z.string()),
      },
    },
    async ({ endDate }) => {
      try {
        const end = endDate
          ? new Date(endDate)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Fetch 14 days of data (this week + last week)
        const data: any[] = [];
        for (let i = 13; i >= 0; i--) {
          const d = new Date(end);
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().split("T")[0];

          try {
            const dayData = await whoopClient.getHomeData(dateStr);
            const live = dayData.metadata?.whoop_live_metadata;

            if (live) {
              data.push({
                date: dateStr,
                recoveryScore: live.recovery_score ?? null,
                strain: live.day_strain ?? null,
                sleepHours: live.ms_of_sleep
                  ? live.ms_of_sleep / (1000 * 60 * 60)
                  : null,
              });
            } else {
              data.push({ date: dateStr, recoveryScore: null, strain: null, sleepHours: null });
            }
          } catch {
            data.push({ date: dateStr, recoveryScore: null, strain: null, sleepHours: null });
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const lastWeekData = data.slice(0, 7);
        const thisWeekData = data.slice(7, 14);

        const calcStats = (arr: any[]) => {
          const validRecovery = arr.filter((d) => d.recoveryScore != null);
          const validStrain = arr.filter((d) => d.strain != null);
          const validSleep = arr.filter((d) => d.sleepHours != null);

          return {
            avgRecovery:
              validRecovery.length > 0
                ? Math.round(
                    validRecovery.reduce((a, b) => a + b.recoveryScore, 0) /
                      validRecovery.length
                  )
                : null,
            avgStrain:
              validStrain.length > 0
                ? Math.round(
                    (validStrain.reduce((a, b) => a + b.strain, 0) /
                      validStrain.length) *
                      10
                  ) / 10
                : null,
            avgSleep:
              validSleep.length > 0
                ? Math.round(
                    (validSleep.reduce((a, b) => a + b.sleepHours, 0) /
                      validSleep.length) *
                      10
                  ) / 10
                : null,
            daysAbove70Recovery: validRecovery.filter((d) => d.recoveryScore >= 70).length,
          };
        };

        const thisWeek = calcStats(thisWeekData);
        const lastWeek = calcStats(lastWeekData);

        const calcChange = (current: number | null, previous: number | null) => {
          if (current == null || previous == null || previous === 0) return null;
          return Math.round(((current - previous) / previous) * 100);
        };

        const changes = {
          recoveryChange: calcChange(thisWeek.avgRecovery, lastWeek.avgRecovery),
          strainChange: calcChange(thisWeek.avgStrain, lastWeek.avgStrain),
          sleepChange: calcChange(thisWeek.avgSleep, lastWeek.avgSleep),
        };

        // Generate insights
        const insights: string[] = [];
        const recommendations: string[] = [];

        if (thisWeek.avgRecovery != null && lastWeek.avgRecovery != null) {
          if (thisWeek.avgRecovery > lastWeek.avgRecovery) {
            insights.push(`Recovery improved by ${changes.recoveryChange}% this week`);
          } else if (thisWeek.avgRecovery < lastWeek.avgRecovery) {
            insights.push(`Recovery declined by ${Math.abs(changes.recoveryChange!)}% this week`);
            recommendations.push("Consider prioritizing sleep and reducing strain");
          }
        }

        if (thisWeek.avgSleep != null) {
          if (thisWeek.avgSleep < 7) {
            insights.push(`Average sleep this week is ${thisWeek.avgSleep} hours (below recommended 7-9 hours)`);
            recommendations.push("Aim for at least 7 hours of sleep per night");
          } else if (thisWeek.avgSleep >= 8) {
            insights.push(`Great sleep average of ${thisWeek.avgSleep} hours this week`);
          }
        }

        if (thisWeek.daysAbove70Recovery >= 5) {
          insights.push(`Strong week with ${thisWeek.daysAbove70Recovery} days of 70%+ recovery`);
          recommendations.push("Good time to push harder in workouts");
        } else if (thisWeek.daysAbove70Recovery <= 2) {
          insights.push(`Only ${thisWeek.daysAbove70Recovery} days with good recovery this week`);
          recommendations.push("Focus on recovery - lighter workouts, more sleep");
        }

        if (thisWeek.avgStrain != null && thisWeek.avgRecovery != null) {
          if (thisWeek.avgStrain > 14 && thisWeek.avgRecovery < 50) {
            insights.push("High strain with low recovery - risk of overtraining");
            recommendations.push("Take a rest day or do active recovery");
          }
        }

        const output = {
          weekOverWeek: {
            thisWeek,
            lastWeek,
            changes,
          },
          insights,
          recommendations,
        };

        // Format text output
        const lines = [
          "📈 WHOOP TRENDS & ANALYTICS",
          "═══════════════════════════",
          "",
          "📊 WEEK OVER WEEK COMPARISON",
          "────────────────────────────",
          "",
          "THIS WEEK (last 7 days):",
          `  Recovery: ${thisWeek.avgRecovery ?? "N/A"}% avg (${thisWeek.daysAbove70Recovery} days above 70%)`,
          `  Strain: ${thisWeek.avgStrain ?? "N/A"} avg`,
          `  Sleep: ${thisWeek.avgSleep ?? "N/A"} hours avg`,
          "",
          "LAST WEEK (previous 7 days):",
          `  Recovery: ${lastWeek.avgRecovery ?? "N/A"}% avg (${lastWeek.daysAbove70Recovery} days above 70%)`,
          `  Strain: ${lastWeek.avgStrain ?? "N/A"} avg`,
          `  Sleep: ${lastWeek.avgSleep ?? "N/A"} hours avg`,
          "",
          "CHANGES:",
          `  Recovery: ${changes.recoveryChange != null ? (changes.recoveryChange >= 0 ? "+" : "") + changes.recoveryChange + "%" : "N/A"}`,
          `  Strain: ${changes.strainChange != null ? (changes.strainChange >= 0 ? "+" : "") + changes.strainChange + "%" : "N/A"}`,
          `  Sleep: ${changes.sleepChange != null ? (changes.sleepChange >= 0 ? "+" : "") + changes.sleepChange + "%" : "N/A"}`,
          "",
        ];

        if (insights.length > 0) {
          lines.push("💡 INSIGHTS", "───────────");
          insights.forEach((i) => lines.push(`  • ${i}`));
          lines.push("");
        }

        if (recommendations.length > 0) {
          lines.push("🎯 RECOMMENDATIONS", "──────────────────");
          recommendations.forEach((r) => lines.push(`  • ${r}`));
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
              text: `Error fetching trends data: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
