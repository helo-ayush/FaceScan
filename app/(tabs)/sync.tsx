/**
 * Data Synchronization & Offline Queue Monitor Screen.
 *
 * Provides visibility and control over the SQLite offline replication pipeline:
 * - Queue Tab: Displays unsynced attendance scans and pending student enrollments.
 * - Latest Tab: Shows recent successfully replicated attendance records and conflicts.
 * - Classes Tab: Details local vs remote status for class rosters and on-device packages.
 * - Manual Sync: Allows immediate on-demand sync trigger with connectivity validation.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Icon } from '@/components/Icon';
import { SkeletonBlock } from '@/components/ScreenSkeleton';
import { AppSettings } from '@/utils/settings';
import { useSyncEngine } from '@/utils/SyncProvider';
import {
  getUnsyncedAttendance,
  getUnsyncedEnrollment,
  getUnsyncedConflicts,
  getCachedClasses,
  type PendingAttendanceRow,
  type PendingEnrollmentRow,
} from '@/utils/localDb';
import { getDownloadedClasses, type DownloadedClassInfo } from '@/utils/classPackageStore';

type Tab = 'queue' | 'latest' | 'classes';

type ServerConflict = {
  _id: string;
  type: string;
  enrollmentNumber: string;
  classId: string;
  message: string;
  severity: 'info' | 'needs_attention';
  createdAt: string;
};

type ServerClass = {
  id: string;
  title: string;
  code: string;
  students: number;
  updatedAt?: string;
};

const formatTime = (value: string | null) => {
  if (!value) return 'Not yet';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatAge = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
};

export default function SyncScreen() {
  const { status, triggerSync, apiUrl } = useSyncEngine();
  const [tab, setTab] = useState<Tab>('queue');
  const [refreshing, setRefreshing] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const hasLoadedSync = useRef(false);
  const [attendance, setAttendance] = useState<PendingAttendanceRow[]>([]);
  const [enrollments, setEnrollments] = useState<PendingEnrollmentRow[]>([]);
  const [localNotes, setLocalNotes] = useState(0);
  const [downloaded, setDownloaded] = useState<DownloadedClassInfo[]>([]);
  const [classes, setClasses] = useState<ServerClass[]>([]);
  const [latestConflicts, setLatestConflicts] = useState<ServerConflict[]>([]);
  const [checkingClasses, setCheckingClasses] = useState(false);
  const [checkingLatest, setCheckingLatest] = useState(false);
  const [lastPushStartedAt, setLastPushStartedAt] = useState<string | null>(status.lastSyncStartedAt);

  const loadLocal = useCallback(async () => {
    const [nextAttendance, nextEnrollments, nextNotes, nextDownloaded] = await Promise.all([
      getUnsyncedAttendance(),
      getUnsyncedEnrollment(),
      getUnsyncedConflicts(),
      getDownloadedClasses(),
    ]);
    setAttendance(nextAttendance);
    setEnrollments(nextEnrollments);
    setLocalNotes(nextNotes.length);
    setDownloaded(nextDownloaded);
  }, []);

  const loadClasses = useCallback(async () => {
    try {
      const cached = await getCachedClasses();
      if (cached.length > 0) {
        setClasses(cached.map((c) => ({ id: c.class_id, title: c.title, code: c.code, students: 0 })));
      }
    } catch {
      // Ignore cache load error
    }

    if (!apiUrl || status.isOnline === false) return;
    setCheckingClasses(true);
    try {
      const response = await fetch(`${apiUrl}/api/classes`);
      const data = await response.json();
      if (response.ok && Array.isArray(data)) setClasses(data);
    } catch {
      // The hero state already communicates that the next check will retry.
    } finally {
      setCheckingClasses(false);
    }
  }, [apiUrl, status.isOnline]);

  const loadLatestConflicts = useCallback(async (windowStart = lastPushStartedAt) => {
    if (!apiUrl || !windowStart) {
      setLatestConflicts([]);
      return;
    }
    setCheckingLatest(true);
    try {
      const response = await fetch(`${apiUrl}/api/sync/conflicts?since=${encodeURIComponent(windowStart)}`);
      const data = await response.json();
      if (response.ok && data.success) {
        // Keep the view focused even against an older backend that ignores `since`.
        setLatestConflicts((data.conflicts || []).filter((item: ServerConflict) => item.createdAt >= windowStart));
      }
    } catch {
      // A network retry happens automatically; the last result stays visible.
    } finally {
      setCheckingLatest(false);
    }
  }, [apiUrl, lastPushStartedAt]);

  useEffect(() => {
    if (status.lastSyncStartedAt) {
      setLastPushStartedAt(status.lastSyncStartedAt);
      void loadLatestConflicts(status.lastSyncStartedAt);
    }
  }, [loadLatestConflicts, status.lastSyncStartedAt]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const showSkeleton = !hasLoadedSync.current;
      if (showSkeleton) setPageLoading(true);
      void Promise.all([loadLocal(), loadClasses(), loadLatestConflicts()]).finally(() => {
        hasLoadedSync.current = true;
        if (active && showSkeleton) setPageLoading(false);
      });
      return () => { active = false; };
    }, [loadClasses, loadLatestConflicts, loadLocal])
  );

  const refreshEverything = async () => {
    setRefreshing(true);
    AppSettings.haptic('light');
    await Promise.all([loadLocal(), loadClasses(), loadLatestConflicts()]);
    setRefreshing(false);
  };

  const syncNow = async () => {
    AppSettings.haptic('medium');
    const windowStart = new Date().toISOString();
    setLastPushStartedAt(windowStart);
    await triggerSync();
    await Promise.all([loadLocal(), loadClasses(), loadLatestConflicts(windowStart)]);
  };

  const pending = attendance.length + enrollments.length + localNotes;
  const className = (classId: string) => classes.find((item) => item.id === classId)?.title || 'Saved class';
  const changedClasses = classes.filter((serverClass) => {
    const local = downloaded.find((item) => item.classId === serverClass.id);
    return Boolean(local && serverClass.updatedAt && local.classUpdatedAt !== serverClass.updatedAt);
  });
  const needsAttention = latestConflicts.filter((item) => item.severity === 'needs_attention');

  const hero = status.isSyncing
    ? { title: 'Syncing your saved work', detail: 'Attendance, enrollment and roster changes are being checked.', icon: 'cloud_sync', color: '#4f46e5', panel: '#eef2ff' }
    : status.isOnline === false
    ? { title: 'Offline — your work is safe', detail: pending ? `${pending} saved item${pending === 1 ? '' : 's'} will upload automatically when internet returns.` : 'New scans and enrollments will be stored safely on this device.', icon: 'cloud_off', color: '#b45309', panel: '#fff7ed' }
    : needsAttention.length
    ? { title: 'A sync item needs attention', detail: 'Review the latest push result below. Everything else continues automatically.', icon: 'sync_problem', color: '#dc2626', panel: '#fef2f2' }
    : pending
    ? { title: `${pending} item${pending === 1 ? '' : 's'} ready to upload`, detail: 'The app will upload these automatically. You can also sync now.', icon: 'cloud_sync', color: '#b45309', panel: '#fffbeb' }
    : { title: 'Everything is up to date', detail: `Last confirmed server contact: ${formatTime(status.lastServerContactAt)}.`, icon: 'cloud_done', color: '#15803d', panel: '#f0fdf4' };

  return (
    <View className="flex-1 bg-[#f8fafc]">
      <ScreenHeader title="Sync center" />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 36 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshEverything} colors={['#4f46e5']} />}
      >
        <Animated.View entering={FadeInUp.duration(320)}>
          <View style={{ backgroundColor: hero.panel, borderRadius: 24, padding: 20, borderWidth: 1, borderColor: `${hero.color}22` }}>
            <View className="flex-row items-start">
              <View style={{ width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' }}>
                <Icon name={hero.icon} size={24} color={hero.color} />
              </View>
              <View className="flex-1 ml-3">
                <Text className="text-[17px] font-extrabold text-slate-900">{hero.title}</Text>
                <Text className="text-xs leading-5 font-semibold text-slate-600 mt-1">{hero.detail}</Text>
              </View>
            </View>
            <Pressable
              onPress={syncNow}
              disabled={status.isSyncing}
              style={{ marginTop: 16, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: status.isSyncing ? '#94a3b8' : '#4f46e5' }}
            >
              {status.isSyncing ? <ActivityIndicator color="#ffffff" /> : <Text className="text-sm font-extrabold text-white">Sync saved records now</Text>}
            </Pressable>
          </View>

          <View className="flex-row mt-4 gap-3">
            <Stat loading={pageLoading} label="Waiting" value={String(pending)} tone={pending ? '#b45309' : '#15803d'} />
            <Stat loading={pageLoading} label="Last upload" value={formatTime(status.lastSyncAt)} tone="#334155" small />
            <Stat loading={pageLoading} label="Classes changed" value={String(changedClasses.length)} tone={changedClasses.length ? '#b45309' : '#15803d'} />
          </View>

          {status.lastError ? (
            <View className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
              <Text className="text-xs font-extrabold text-red-700">Last upload attempt</Text>
              <Text className="text-xs leading-5 font-semibold text-red-700 mt-1">{status.lastError}</Text>
            </View>
          ) : null}

          <View className="flex-row bg-slate-200/70 rounded-2xl p-1 mt-6">
            <TabButton active={tab === 'queue'} label={`Waiting (${pending})`} onPress={() => setTab('queue')} />
            <TabButton active={tab === 'latest'} label="Latest push" onPress={() => setTab('latest')} />
            <TabButton active={tab === 'classes'} label="Classes" onPress={() => setTab('classes')} />
          </View>

          {pageLoading ? <InlineContentSkeleton /> : tab === 'queue' ? (
            <View className="mt-5 gap-3">
              {pending === 0 ? <Empty icon="check_circle" title="No uploads waiting" detail="New attendance and registrations will appear here only until the server confirms them." /> : null}
              {attendance.length ? <QueueSection title="Attendance waiting" subtitle="These marks are saved on this phone and will upload automatically." count={attendance.length}>
                {attendance.map((item) => <AttendanceItem key={item.id} item={item} className={className(item.class_id)} />)}
              </QueueSection> : null}
              {enrollments.length ? <QueueSection title="Registrations waiting" subtitle="Face templates stay private on this phone until upload succeeds." count={enrollments.length}>
                {enrollments.map((item) => <EnrollmentItem key={item.id} item={item} className={className(item.class_id)} />)}
              </QueueSection> : null}
              {localNotes ? <Text className="text-center text-xs font-semibold text-slate-500">{localNotes} sync note{localNotes === 1 ? '' : 's'} will be sent automatically.</Text> : null}
            </View>
          ) : null}

          {tab === 'latest' ? (
            <View className="mt-5 gap-3">
              <View className="flex-row items-center justify-between px-1">
                <View>
                  <Text className="text-sm font-extrabold text-slate-900">Results from the latest push</Text>
                  <Text className="text-xs font-semibold text-slate-500 mt-1">Older conflicts are deliberately hidden to keep this useful.</Text>
                </View>
                <Pressable onPress={() => void loadLatestConflicts()} className="p-2">
                  {checkingLatest ? <ActivityIndicator size="small" color="#4f46e5" /> : <Icon name="refresh" size={20} color="#4f46e5" />}
                </Pressable>
              </View>
              {latestConflicts.length === 0 ? <Empty icon="check_circle" title="Latest push completed cleanly" detail="No duplicates or enrollment conflicts were reported in the most recent upload." /> : latestConflicts.map((item) => <ConflictItem key={item._id} item={item} className={className(item.classId)} />)}
            </View>
          ) : null}

          {tab === 'classes' ? (
            <View className="mt-5 gap-3">
              <View className="flex-row items-center justify-between px-1">
                <View>
                  <Text className="text-sm font-extrabold text-slate-900">Class dataset health</Text>
                  <Text className="text-xs font-semibold text-slate-500 mt-1">Offline class data refreshes automatically during a successful sync.</Text>
                </View>
                <Pressable onPress={() => void loadClasses()} className="p-2">
                  {checkingClasses ? <ActivityIndicator size="small" color="#4f46e5" /> : <Icon name="refresh" size={20} color="#4f46e5" />}
                </Pressable>
              </View>
              {classes.length === 0 ? <Empty icon={status.isOnline === false ? 'cloud_off' : 'school'} title={status.isOnline === false ? 'Connect to check classes' : 'Checking datasets'} detail="Downloaded classes remain usable offline. Their freshness will be checked as soon as the server is available." /> : classes.map((item) => {
                const local = downloaded.find((saved) => saved.classId === item.id);
                const changed = Boolean(local && item.updatedAt && local.classUpdatedAt !== item.updatedAt);
                return <ClassItem key={item.id} item={item} local={local} changed={changed} />;
              })}
            </View>
          ) : null}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, tone, small, loading }: { label: string; value: string; tone: string; small?: boolean; loading?: boolean }) {
  return <View className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-3">
    {loading ? <SkeletonBlock width={small ? 52 : 32} height={small ? 14 : 24} radius={7} /> : <Text style={{ color: tone, fontSize: small ? 12 : 20, fontWeight: '900' }} numberOfLines={1}>{value}</Text>}
    <Text className="text-[10px] font-bold text-slate-500 mt-1" numberOfLines={1}>{label}</Text>
  </View>;
}

function InlineContentSkeleton() {
  return <View className="mt-5 gap-3">
    {[0, 1, 2].map((item) => <View key={item} className="rounded-3xl border border-slate-200 bg-white p-4"><SkeletonBlock width="42%" height={16} radius={8} /><View className="mt-3"><SkeletonBlock height={12} radius={6} /></View><View className="mt-2"><SkeletonBlock width="70%" height={12} radius={6} /></View></View>)}
  </View>;
}

function TabButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} className={`flex-1 min-h-10 items-center justify-center rounded-xl ${active ? 'bg-white' : ''}`}>
    <Text className={`text-[11px] font-extrabold ${active ? 'text-indigo-600' : 'text-slate-500'}`} numberOfLines={1}>{label}</Text>
  </Pressable>;
}

function Empty({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return <View className="rounded-3xl border border-slate-200 bg-white items-center px-6 py-8">
    <View className="h-12 w-12 rounded-2xl bg-slate-100 items-center justify-center"><Icon name={icon} size={24} color="#64748b" /></View>
    <Text className="text-sm font-extrabold text-slate-900 mt-3">{title}</Text>
    <Text className="text-xs leading-5 font-semibold text-slate-500 text-center mt-1">{detail}</Text>
  </View>;
}

function QueueSection({ title, subtitle, count, children }: { title: string; subtitle: string; count: number; children: React.ReactNode }) {
  return <View className="rounded-3xl border border-slate-200 bg-white overflow-hidden">
    <View className="px-4 pt-4 pb-3 border-b border-slate-100"><View className="flex-row items-center justify-between"><Text className="text-sm font-extrabold text-slate-900">{title}</Text><Text className="text-[11px] font-extrabold text-amber-700 bg-amber-100 px-2 py-1 rounded-full">{count}</Text></View><Text className="text-xs leading-4 font-semibold text-slate-500 mt-1">{subtitle}</Text></View>
    {children}
  </View>;
}

function AttendanceItem({ item, className }: { item: PendingAttendanceRow; className: string }) {
  return <View className="px-4 py-3 border-b border-slate-100 last:border-b-0"><Text className="text-sm font-extrabold text-slate-800">Student #{item.enrollment_number}</Text><Text className="text-xs font-semibold text-slate-500 mt-1">{className} · captured {formatAge(item.captured_at)}</Text>{item.last_error ? <Text className="text-[11px] font-bold text-red-600 mt-2">{item.last_error} · retry {item.retry_count}</Text> : <Text className="text-[11px] font-bold text-amber-700 mt-2">Ready to upload automatically</Text>}</View>;
}

function EnrollmentItem({ item, className }: { item: PendingEnrollmentRow; className: string }) {
  return <View className="px-4 py-3 border-b border-slate-100 last:border-b-0"><Text className="text-sm font-extrabold text-slate-800">{item.name}</Text><Text className="text-xs font-semibold text-slate-500 mt-1">New registration · {className}</Text>{item.last_error ? <Text className="text-[11px] font-bold text-red-600 mt-2">{item.last_error} · retry {item.retry_count}</Text> : <Text className="text-[11px] font-bold text-amber-700 mt-2">Face templates saved and ready to upload</Text>}</View>;
}

function ConflictItem({ item, className }: { item: ServerConflict; className: string }) {
  const urgent = item.severity === 'needs_attention';
  return <View className={`rounded-2xl border p-4 ${urgent ? 'border-red-200 bg-red-50' : 'border-blue-100 bg-blue-50'}`}><View className="flex-row justify-between gap-3"><Text className={`text-xs font-extrabold ${urgent ? 'text-red-700' : 'text-blue-700'}`}>{urgent ? 'Needs attention' : 'Duplicate handled safely'}</Text><Text className="text-[10px] font-bold text-slate-500">{formatTime(item.createdAt)}</Text></View><Text className="text-xs leading-5 font-semibold text-slate-700 mt-2">{item.message}</Text><Text className="text-[11px] font-bold text-slate-500 mt-2">{className} · Student #{item.enrollmentNumber}</Text></View>;
}

function ClassItem({ item, local, changed }: { item: ServerClass; local?: DownloadedClassInfo; changed: boolean }) {
  const status = !local ? { label: 'NOT DOWNLOADED', color: '#475569', bg: '#f1f5f9' } : changed ? { label: 'REFRESHING', color: '#b45309', bg: '#fef3c7' } : { label: 'READY OFFLINE', color: '#166534', bg: '#dcfce7' };
  return <View className="rounded-3xl border border-slate-200 bg-white p-4"><View className="flex-row items-start justify-between gap-3"><View className="flex-1"><Text className="text-sm font-extrabold text-slate-900">{item.title}</Text><Text className="text-xs font-semibold text-slate-500 mt-1">{item.code} · {item.students} students on server</Text></View><View style={{ backgroundColor: status.bg, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 }}><Text style={{ color: status.color, fontSize: 10, fontWeight: '900' }}>{status.label}</Text></View></View><Text className="text-xs leading-5 font-semibold text-slate-600 mt-3">{!local ? 'Download this class from Classes to scan it without internet.' : changed ? 'The roster changed. The next successful sync refreshes this device automatically.' : `${local.studentCount} face templates saved on this device for offline scanning.`}</Text></View>;
}
