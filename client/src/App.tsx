import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ProtectedRoute } from './components/common/ProtectedRoute';

// Import Pages
import { Login } from './pages/Login';
import { SSOCallback } from './pages/SSOCallback';
import { Dashboard } from './pages/Dashboard';
import { AdminDashboard } from './pages/AdminDashboard';
import { Pending } from './pages/Pending';
import { MarkAttendance } from './pages/MarkAttendance';
import { AttendanceRecords } from './pages/AttendanceRecords';
import { MyAttendance } from './pages/MyAttendance';
import { StaffAttendance } from './pages/StaffAttendance';
import { Reports } from './pages/Reports';
import { Directory } from './pages/Directory';
import { Settings } from './pages/Settings';
import { NotFound } from './pages/NotFound';
import { Schedule } from './pages/Schedule';
import { LeaveRequests } from './pages/LeaveRequests';
import { Analytics } from './pages/Analytics';
import { LogIncident } from './pages/LogIncident';
import { DisciplineRecords } from './pages/DisciplineRecords';
import { MyConduct } from './pages/MyConduct';
import { ExcuseReview } from './pages/ExcuseReview';
import { AuditLog } from './pages/AuditLog';
import { StudentReport } from './pages/StudentReport';

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <ToastProvider>
      <BrowserRouter>
        <Routes>
          {/* Public Portal Routes */}
          <Route path="/" element={<Login />} />
          <Route path="/sso/callback" element={<SSOCallback />} />
          <Route path="/callback" element={<SSOCallback />} />

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
            path="/attendance/me"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <MyAttendance />
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedule"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Schedule />
              </ProtectedRoute>
            }
          />
          <Route
            path="/excuses"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <LeaveRequests />
              </ProtectedRoute>
            }
          />
          <Route
            path="/analytics"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Analytics />
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
    </AuthProvider>
  );
};

export default App;
