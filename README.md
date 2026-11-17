# IT Helpdesk Ticket System

A lightweight, web‑based ticketing system designed for internal IT support teams. It provides a simple interface for users to submit support requests, tracks ticket status, and enables administrators to manage, prioritize, and resolve issues efficiently.

---

## ✨ Features
- **User portal** – Submit tickets with optional attachments.
- **Admin dashboard** – View, filter, assign, and close tickets.
- **Email notifications** – Automatic alerts for new tickets and status changes.
- **Role‑based access** – Separate permissions for users, agents, and admins.
- **Search & export** – Quick search across tickets and CSV export for reporting.
- **Docker ready** – Run the entire stack with a single `docker‑compose up`.

---

## 🛠️ Tech Stack
| Layer | Technology |
|------|------------|
| **Backend** | Node.js (Express) |
| **Database** | MySQL (via `mysql2` driver) |
| **Authentication** | JWT + bcrypt |
| **File storage** | Local `uploads/` directory |
| **Frontend** | HTML/CSS/JavaScript (Vanilla) |
| **Containerization** | Docker & Docker‑Compose |

---

## 📦 Getting Started
### Prerequisites
- Docker & Docker‑Compose (or Node 12+ and MySQL locally)
- `git`

### Clone the repo
```bash
git clone <repo‑url>
cd it-helpdesk-ticket-system
```

### Environment variables
Create a `.env` file in the project root (copy from `.env.example` if present) with at least:
```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=helpdesk
JWT_SECRET=your_jwt_secret
```

### Initialise the database
```bash
# Using the bundled script
node scripts/init-db.js
# Or with Docker (see below)
```

### Run locally (non‑Docker)
```bash
npm install
npm start   # starts on http://localhost:$PORT
```

### Run with Docker
```bash
# Build and start all services
docker-compose up --build
```
The app will be reachable at `http://localhost:3000`.

---

## 📚 API Overview
All endpoints are prefixed with `/api` and return JSON.
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Authenticate and receive a JWT |
| `POST` | `/api/tickets` | Create a new ticket (authenticated users) |
| `GET`  | `/api/tickets` | List tickets (admin/agent filters available) |
| `GET`  | `/api/tickets/:id` | Get ticket details |
| `PUT`  | `/api/tickets/:id` | Update status, assign agent, add notes |
| `DELETE`| `/api/tickets/:id` | Delete a ticket (admin only) |

For full docs, see `docs/api.md` (to be added).

---

## 🤝 Contributing
1. Fork the repository.
2. Create a feature branch (`git checkout -b feat/awesome-feature`).
3. Ensure code follows the existing style and run lint/tests.
4. Open a Pull Request describing your changes.

All contributions are welcome!

---

## 📄 License
This project is licensed under the MIT License – see the LICENSE file for details.

---

## 🙋‍♂️ Support
For bugs or feature requests, open an issue on the repository or contact the maintainer.
