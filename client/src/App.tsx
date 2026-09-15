import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { AcademicPeriodProvider } from './context/AcademicPeriodContext';
import { ToastProvider } from './context/ToastContext';
import { ProtectedRoute } from './components/common/ProtectedRoute';

// Import Pages
import { Login } from './pages/Login';
import { SSOCallback } from './pages/SSOCallback';
import { Welcome } from './pages/Welcome';
import { Dashboard } from './pages/Dashboard';
import { AttendanceCalendarGate } from './pages/AttendanceCalendarGate';
import { AdminDashboard } from './pages/AdminDashboard';
import { RolesPermissions } from './pages/RolesPermissions';
import { Pending } from './pages/Pending';
import { MarkAttendance } from './pages/MarkAttendance';
import { AttendanceRecords } from './pages/AttendanceRecords';
import { StaffAttendance } from './pages/StaffAttendance';
import { Reports } from './pages/Reports';
import { Directory } from './pages/Directory';
import { Settings } from './pages/Settings';
import { NotFound } from './pages/NotFound';
import { Excuses } from './pages/Excuses';
import { ExcuseNew } from './pages/ExcuseNew';
import { ExcuseDetail } from './pages/ExcuseDetail';
import { LogIncident } from './pages/LogIncident';
import { DisciplineRecords } from './pages/DisciplineRecords';
import { DisciplineRules } from './pages/DisciplineRules';
import { MyConduct } from './pages/MyConduct';
import { ExcuseReview } from './pages/ExcuseReview';
import { AuditLog } from './pages/AuditLog';
import { StudentReport } from './pages/StudentReport';
import { AttendanceReportGate } from './pages/AttendanceReportGate';
import { SessionDetail } from './pages/SessionDetail';

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <AcademicPeriodProvider>
      <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* Public Portal Routes */}
          <Route path="/" element={<Login />} />
          <Route path="/sso/callback" element={<SSOCallback />} />
          <Route path="/callback" element={<SSOCallback />} />

          {/* Shared post-login landing for every assigned role */}
          <Route
            path="/welcome"
            element={
              <ProtectedRoute>
                <Welcome />
              </ProtectedRoute>
            }
          />

          {/* Unassigned users land here until an admin grants a role */}
          <Route
            path="/pending"
            element={
              <ProtectedRoute allowedRoles={['unassigned']}>
                <Pending />
              </ProtectedRoute>
            }
          />

          {/* Admin console (admin only) */}
          <Route
            path="/admin"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/audit"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <AuditLog />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/roles"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <RolesPermissions />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports/student/:id"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <StudentReport />
              </ProtectedRoute>
            }
          />

          {/* Protected Routes */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher', 'student']}>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/attendance"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher', 'student']}>
                <AttendanceCalendarGate />
              </ProtectedRoute>
            }
          />
          <Route
            path="/attendance/session"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher', 'student']}>
                <SessionDetail />
              </ProtectedRoute>
            }
          />
          <Route path="/today" element={<Navigate to="/attendance?view=day" replace />} />
          <Route path="/schedule" element={<Navigate to="/attendance?view=week" replace />} />
          <Route
            path="/attendance/mark"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <MarkAttendance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/attendance/records"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <AttendanceRecords />
              </ProtectedRoute>
            }
          />
          <Route
            path="/attendance/report"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher', 'student']}>
                <AttendanceReportGate />
              </ProtectedRoute>
            }
          />
          <Route
            path="/excuses"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Excuses />
              </ProtectedRoute>
            }
          />
          <Route
            path="/excuses/new"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <ExcuseNew />
              </ProtectedRoute>
            }
          />
          <Route
            path="/excuses/:id"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <ExcuseDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/discipline/log"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <LogIncident />
              </ProtectedRoute>
            }
          />
          <Route
            path="/discipline/records"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <DisciplineRecords />
              </ProtectedRoute>
            }
          />
          <Route
            path="/discipline/rules"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <DisciplineRules />
              </ProtectedRoute>
            }
          />
          <Route
            path="/discipline/me"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <MyConduct />
              </ProtectedRoute>
            }
          />
          <Route
            path="/excuses/review"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <ExcuseReview />
              </ProtectedRoute>
            }
          />
          <Route
            path="/staff/attendance"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <StaffAttendance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <Reports />
              </ProtectedRoute>
            }
          />
          <Route
            path="/directory"
            element={
              <ProtectedRoute allowedRoles={['admin', 'teacher']}>
                <Directory />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />

          {/* 404 Route */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
      </ToastProvider>
      </AcademicPeriodProvider>
    </AuthProvider>
  );
};

export default App;
