import { prisma } from '../server/prisma'
import { ncp } from 'ncp'

export const tag = [
  {
    "id": 1,
    "name": "Welcome",
    "icon": "\uD83C\uDF89",
    "parent": 0
  },
  {
    "id": 2,
    "name": "Attachment",
    "icon": "\uD83D\uDD16",
    "parent": 1
  },
  {
    "id": 3,
    "name": "Code",
    "icon": "\uD83E\uDE84",
    "parent": 1
  },
  {
    "id": 4,
    "name": "To-Do",
    "icon": "✨",
    "parent": 1
  },
  {
    "id": 5,
    "name": "Multi-Level-Tags",
    "icon": "\uD83C\uDFF7\uFE0F",
    "parent": 1
  }
]

export const attachments: any = [
  {
    "id": 1,
    "isShare": false,
    "sharePassword": "",
    "name": "pic01.png",
    "path": "/api/file/pic01.png",
    "size": 1360952,
    "noteId": 2
  },
  {
    "id": 2,
    "isShare": false,
    "sharePassword": "",
    "name": "pic02.png",
    "path": "/api/file/pic02.png",
    "size": 971782,
    "noteId": 2
  },
  {
    "id": 3,
    "isShare": false,
    "sharePassword": "",
    "name": "pic03.png",
    "path": "/api/file/pic03.png",
    "size": 141428,
    "noteId": 2
  },
  {
    "id": 4,
    "isShare": false,
    "sharePassword": "",
    "name": "pic04.png",
    "path": "/api/file/pic04.png",
    "size": 589371,
    "noteId": 2
  },
  {
    "id": 5,
    "isShare": false,
    "sharePassword": "",
    "name": "pic06.png",
    "path": "/api/file/pic06.png",
    "size": 875361,
    "noteId": 2
  },
  {
    "id": 6,
    "isShare": false,
    "sharePassword": "",
    "name": "story.txt",
    "path": "/api/file/story.txt",
    "size": 0,
    "noteId": 2
  }
]

export const notes = [
  {
    "id": 1,
    "type": 0,
    "content": "#Welcome\n\nWelcome to Blinko!\n\nWhether you're capturing ideas, taking meeting notes, or planning your schedule, Blinko provides an easy and efficient way to manage it all. Here, you can create, edit, and share notes anytime, anywhere, ensuring you never lose a valuable thought.",
    "isArchived": false,
    "isRecycle": false,
    "isShare": false,
    "isTop": false,
    "sharePassword": ""
  },
  {
    "id": 2,
    "type": 0,
    "content": "#Welcome/Attachment",
    "isArchived": false,
    "isRecycle": false,
    "isShare": false,
    "isTop": false,
    "sharePassword": ""
  },
  {
    "id": 3,
    "type": 0,
    "content": "#Welcome/Code\n\n\n\n```js\nfunction Welcome(){\n  console.log(\"Hello! Blinko\");\n}\n```",
    "isArchived": false,
    "isRecycle": false,
    "isShare": false,
    "isTop": false,
    "sharePassword": ""
  },
  {
    "id": 4,
    "type": 0,
    "content": "#Welcome/To-Do\n\n* Create a blinko\n* Create a note\n* Upload file",
    "isArchived": false,
    "isRecycle": false,
    "isShare": false,
    "isTop": false,
    "sharePassword": ""
  },
  {
    "id": 5,
    "type": 0,
    "content": "#Welcome/Multi-Level-Tags\n\nUse the \"/\" shortcut to effortlessly create and organize multi-level tags.",
    "isArchived": false,
    "isRecycle": false,
    "isShare": false,
    "isTop": false,
    "sharePassword": ""
  },
  {
    "id": 6,
    "type": 0,
    "content": "https://github.com/blinko-space/blinko/",
    "isArchived": false,
    "isRecycle": false,
    "isShare": false,
    "isTop": false,
    "sharePassword": ""
  }
]

export const tagsToNote = [
  {
    "id": 1,
    "noteId": 1,
    "tagId": 1
  },
  {
    "id": 2,
    "noteId": 2,
    "tagId": 1
  },
  {
    "id": 3,
    "noteId": 2,
    "tagId": 2
  },
  {
    "id": 4,
    "noteId": 3,
    "tagId": 1
  },
  {
    "id": 5,
    "noteId": 3,
    "tagId": 3
  },
  {
    "id": 6,
    "noteId": 4,
    "tagId": 1
  },
  {
    "id": 7,
    "noteId": 4,
    "tagId": 4
  },
  {
    "id": 8,
    "noteId": 5,
    "tagId": 1
  },
  {
    "id": 9,
    "noteId": 5,
    "tagId": 5
  }
]

export async function createSeed(accountId: number) {
  try {
    const hasNotes = await prisma.notes.findMany();
    if (hasNotes.length == 0) {
      await prisma.$executeRaw`SELECT setval('notes_id_seq', 1, false);`
      await prisma.$executeRaw`SELECT setval('tag_id_seq', 1, false);`
      await prisma.$executeRaw`SELECT setval('"tagsToNote_id_seq"', 1, false);`
      await prisma.$executeRaw`SELECT setval('attachments_id_seq', 1, false);`

      await prisma.notes.createMany({ 
        data: notes.map(note => ({
          ...note,
          accountId
        }))
      });
      
      await prisma.tag.createMany({ 
        data: tag.map(t => ({
          ...t,
          accountId
        }))
      });
      
      await prisma.tagsToNote.createMany({ data: tagsToNote });
      await prisma.attachments.createMany({ data: attachments });

      await prisma.$executeRaw`SELECT setval('notes_id_seq', (SELECT MAX(id) FROM "notes") + 1);`
      await prisma.$executeRaw`SELECT setval('tag_id_seq', (SELECT MAX(id) FROM "tag") + 1);`
      await prisma.$executeRaw`SELECT setval('"tagsToNote_id_seq"', (SELECT MAX(id) FROM "tagsToNote") + 1);`
      await prisma.$executeRaw`SELECT setval('attachments_id_seq', (SELECT MAX(id) FROM "attachments") + 1);`
      ncp('prisma/seedfiles', ".blinko/files", (err) => {
        if (err) {
          console.log(err)
        }
      })
    }
  } catch (error) {
    console.error('createSeed error', error)
  }
}
