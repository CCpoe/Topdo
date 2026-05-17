import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import type { Habit, HabitLog, HabitWithStats } from '../types/habit';

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timeKey(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseDays(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter((day) => day >= 0 && day <= 6);
  if (typeof value === 'string' && value.trim()) {
    try { return parseDays(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function normalizeHabit(habit: Habit | any): Habit {
  return {
    ...habit,
    frequency_days: parseDays(habit.frequency_days),
    remind_time: habit.remind_time || '',
    target_days: habit.target_days === null || habit.target_days === undefined ? null : Number(habit.target_days),
    is_archived: Boolean(habit.is_archived)
  };
}

export function isRequiredDay(date: Date, habit: Habit): boolean {
  const dow = date.getDay();
  if (habit.frequency_type === 'daily') return true;
  if (habit.frequency_type === 'weekdays') return dow >= 1 && dow <= 5;
  return habit.frequency_days?.includes(dow) ?? false;
}

function isCheckedAt(habit: Habit, logs: HabitLog[], date: string): boolean {
  return logs.some((log) => log.habit_id === habit.id && log.checked_at === date);
}

function calculateCurrentStreak(habit: Habit, logs: HabitLog[]): number {
  let streak = 0;
  const cursor = new Date();
  const today = dateKey(cursor);
  if (isRequiredDay(cursor, habit) && !logs.some((log) => log.checked_at === today)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  for (let guard = 0; guard < 3660; guard += 1) {
    const key = dateKey(cursor);
    if (isRequiredDay(cursor, habit)) {
      if (logs.some((log) => log.checked_at === key)) streak += 1;
      else break;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function calculateLongestStreak(habit: Habit, logs: HabitLog[]): number {
  const done = new Set(logs.map((log) => log.checked_at));
  if (!logs.length) return 0;
  const sorted = [...logs].sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  let start = new Date(sorted[0].checked_at);
  const end = new Date();
  let current = 0;
  let longest = 0;
  for (let guard = 0; start <= end && guard < 3660; guard += 1) {
    const key = dateKey(start);
    if (isRequiredDay(start, habit)) {
      if (done.has(key)) current += 1;
      else current = 0;
      longest = Math.max(longest, current);
    }
    start.setDate(start.getDate() + 1);
  }
  return longest;
}

function calculateWeekStatus(habit: Habit, logs: HabitLog[]): HabitWithStats['weekStatus'] {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(monday);
    current.setDate(monday.getDate() + index);
    const key = dateKey(current);
    if (key === dateKey(today)) return logs.some((log) => log.checked_at === key) ? 'done' : 'today';
    if (current > today) return 'future';
    if (!isRequiredDay(current, habit)) return 'na';
    return logs.some((log) => log.checked_at === key) ? 'done' : 'missed';
  });
}

function calculateMonthRate(habit: Habit, logs: HabitLog[]): number {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  let required = 0;
  let done = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    if (!isRequiredDay(d, habit)) continue;
    required += 1;
    if (logs.some((log) => log.checked_at === dateKey(d))) done += 1;
  }
  return required ? Math.round((done / required) * 100) : 0;
}

function buildHabitStats(habit: Habit, allLogs: HabitLog[]): HabitWithStats {
  const logs = allLogs.filter((log) => log.habit_id === habit.id).sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  const today = dateKey(new Date());
  const todayLog = logs.find((log) => log.checked_at === today);
  return {
    ...habit,
    currentStreak: calculateCurrentStreak(habit, logs),
    longestStreak: calculateLongestStreak(habit, logs),
    todayChecked: Boolean(todayLog),
    todayCheckTime: todayLog?.checked_time,
    weekStatus: calculateWeekStatus(habit, logs),
    monthCompletionRate: calculateMonthRate(habit, logs)
  };
}

export const useHabitStore = defineStore('habit', {
  state: () => ({ habits: [] as Habit[], logs: [] as HabitLog[] }),
  getters: {
    activeHabits: (state) => state.habits.filter((habit) => !habit.is_archived),
    todayStats(state) {
      const today = new Date();
      const todayKey = dateKey(today);
      const active = state.habits.filter(
        (habit) => !habit.is_archived && (isRequiredDay(today, habit) || isCheckedAt(habit, state.logs, todayKey))
      );
      const checked = active.filter((habit) => isCheckedAt(habit, state.logs, todayKey)).length;
      return { total: active.length, checked, percentage: active.length ? Math.round((checked / active.length) * 100) : 0 };
    },
    habitsWithStats(state): HabitWithStats[] {
      return state.habits.filter((habit) => !habit.is_archived).map((habit) => buildHabitStats(habit, state.logs));
    },
    habitsGrouped(state): { pending: HabitWithStats[]; checked: HabitWithStats[]; notToday: HabitWithStats[] } {
      const today = new Date();
      const todayKey = dateKey(today);
      const all = state.habits.filter((habit) => !habit.is_archived).map((habit) => buildHabitStats(habit, state.logs));
      return {
        pending: all.filter((habit) => isRequiredDay(today, habit) && !habit.todayChecked),
        checked: all.filter((habit) => isCheckedAt(habit, state.logs, todayKey)),
        notToday: all.filter((habit) => !isRequiredDay(today, habit) && !isCheckedAt(habit, state.logs, todayKey))
      };
    }
  },
  actions: {
    async fetchHabits() {
      const [habits, logs] = await Promise.all([invoke<Habit[]>('get_habits'), invoke<HabitLog[]>('get_habit_logs')]);
      this.habits = habits.map(normalizeHabit);
      this.logs = logs;
    },
    getHabitStats(habit: Habit): HabitWithStats {
      return buildHabitStats(habit, this.logs);
    },
    async createHabit(input: Partial<Habit>) {
      const habit = await invoke<Habit>('create_habit', { fields: serializeHabitFields(input) });
      this.habits.unshift(normalizeHabit(habit));
    },
    async updateHabit(id: string, updates: Partial<Habit>) {
      const updated = await invoke<Habit>('update_habit', { id, fields: serializeHabitFields(updates) });
      const index = this.habits.findIndex((habit) => habit.id === id);
      if (index >= 0) this.habits[index] = normalizeHabit(updated);
    },
    async archiveHabit(id: string) { await this.updateHabit(id, { is_archived: true }); },
    async deleteHabit(id: string) {
      await invoke<boolean>('delete_habit', { id });
      this.habits = this.habits.filter((habit) => habit.id !== id);
      this.logs = this.logs.filter((log) => log.habit_id !== id);
    },
    async checkIn(habitId: string, note = '') {
      const today = dateKey(new Date());
      if (this.logs.some((log) => log.habit_id === habitId && log.checked_at === today)) return;
      const log = await invoke<HabitLog>('check_in_habit', { habitId, habit_id: habitId, checkedAt: today, checked_at: today, checkedTime: timeKey(new Date()), checked_time: timeKey(new Date()), note });
      this.logs.push(log);
    },
    async uncheckIn(habitId: string, date: string) {
      await invoke<boolean>('uncheck_in_habit', { habitId, habit_id: habitId, checkedAt: date, checked_at: date });
      this.logs = this.logs.filter((log) => !(log.habit_id === habitId && log.checked_at === date));
    }
  }
});

function serializeHabitFields(input: Partial<Habit>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) fields[key] = '';
    else if (key === 'frequency_days') fields[key] = JSON.stringify(value);
    else if (key === 'is_archived') fields[key] = value ? '1' : '0';
    else fields[key] = String(value);
  }
  return fields;
}
