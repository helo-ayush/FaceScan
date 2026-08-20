import React from "react";
import { BackHandler } from "react-native";
import { Tabs, useFocusEffect, useRouter } from "expo-router";
import { Icon } from "@/components/Icon";
import { useAdminAuth } from "@/utils/AdminAuthProvider";

export default function TabsLayout() {
  const router = useRouter();
  const { isAdminUnlocked, lockAdmin } = useAdminAuth();

  useFocusEffect(
    React.useCallback(() => {
      if (!isAdminUnlocked) {
        router.replace("/login");
        return;
      }

      // Android hardware back. Two separate things made the default wrong:
      //  - the root stack still holds the `/login` screen we signed in through, so
      //    an ordinary pop landed on the password form instead of the scan screen;
      //  - bottom-tabs' default `backBehavior` sends back to the first tab, so
      //    leaving admin from any other tab took two presses.
      // `dismissTo` pops everything above `/`, which is the stack's initial route,
      // so one press always lands on the scan screen. BackHandler runs subscribers
      // newest-first and NavigationContainer registers its own on mount, so this
      // one — registered later, on focus — is consulted first.
      const backSubscription = BackHandler.addEventListener("hardwareBackPress", () => {
        router.dismissTo("/");
        return true;
      });

      // Tabs may switch freely. Leaving the entire Admin group locks it, so a
      // fresh username/password entry is always required on the next visit.
      return () => {
        backSubscription.remove();
        lockAdmin();
      };
    }, [isAdminUnlocked, lockAdmin, router])
  );

  if (!isAdminUnlocked) return null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#4f46e5",
        tabBarInactiveTintColor: "#475569",
        tabBarStyle: {
          backgroundColor: "#ffffff",
          borderTopWidth: 1,
          borderTopColor: "rgba(15, 23, 42, 0.06)",
          height: 76,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "700",
          marginTop: 4,
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => (
            <Icon name="dashboard" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="classes"
        options={{
          title: "Classes",
          tabBarIcon: ({ color, size }) => (
            <Icon name="school" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="enroll"
        options={{
          title: "Enroll",
          tabBarIcon: ({ color, size }) => (
            <Icon name="person_add" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="logs"
        options={{
          title: "Logs",
          tabBarIcon: ({ color, size }) => (
            <Icon name="history" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="sync"
        options={{
          title: "Sync",
          tabBarIcon: ({ color, size }) => (
            <Icon name="sync" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
