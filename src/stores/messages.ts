import { defineStore } from 'pinia';
import { ref, reactive } from 'vue';
import { useAuth } from '@/composables/auth';
import { FirebaseError } from 'firebase/app';
import { useUserdataStore } from '@/stores/userdata';
import { getFirestore, collection, doc, setDoc, orderBy, query, Timestamp, onSnapshot, limit, getDoc, getDocs, startAfter } from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, getBlob } from 'firebase/storage';
import { uuidv4 } from '@firebase/util';
import type { UserInfo } from '@/stores/userdata';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import type { ChatInfo } from '@/composables/chat';
import type { Message } from '@/types/message/Message';

type direction = 'start' | 'end';
export interface LastVisibleFirebaseMessageRef {
	top: QueryDocumentSnapshot<DocumentData> | null;
	bottom: QueryDocumentSnapshot<DocumentData> | null;
}

export const useMessagesStore = defineStore('messages', () => {
	const { getUid } = useAuth();
	const { getUserdataById } = useUserdataStore();
	const db = getFirestore();
	const storage = getStorage();
	const chatCol = collection(db, 'chat');

	const messages = ref<Array<Message>>([]);
	const lastVisible: LastVisibleFirebaseMessageRef = reactive({
		top: null,
		bottom: null
	});
	const clearMessages = () => {
		messages.value = [];
	};
	const addMessage = (msg: Message, direct?: direction) => {
		if (direct === 'end' || !direct) {
			messages.value.push(msg);
		} else {
			messages.value.unshift(msg);
		}
	};
	const deleteMessages = (count = 10, direct?: direction) => {
		if (direct === 'end' || !direct) {
			messages.value.splice(-count, count);
		} else {
			messages.value.splice(0, count);
		}
	};
	const uploadMedia = async (chatId: ChatInfo['id'], messageId: Message['id'], { subtitle, files }) => {
		if (files.every(f => f.data instanceof File)) {
			const promises = [];
			for (const file of files) {
				promises.push(
					(async () => {
						const { data: fileData, id, ...data } = file;
						const imageRef = storageRef(
							storage,
							`chat/${chatId}/messageData/${messageId}/${id + '.' + fileData.name.split('.')[fileData.name.split('.').length - 1]}`
						);
						await uploadBytes(imageRef, fileData, {
							contentType: fileData.type
						});
						return {
							id,
							fullname: fileData.name,
							type: fileData.type,
							fullpath: imageRef.fullPath,
							downloadURL: await getDownloadURL(imageRef),
							...data
						};
					})()
				);
			}
			return {
				subtitle,
				images: await Promise.all(promises)
			};
		}
	};
	const uploadFile = async (chatId: ChatInfo['id'], messageId: Message['id'], { subtitle, file }) => {
		if (file instanceof File) {
			const fileRef = storageRef(storage, `chat/${chatId}/messageData/${messageId}/${uuidv4() + '.' + file.name.split('.')[file.name.split('.').length - 1]}`);
			await uploadBytes(fileRef, file, {
				contentType: file.type
			});
			return {
				subtitle,
				file: {
					fullname: file.name,
					type: file.type,
					fullpath: fileRef.fullPath,
					size: file.size,
					downloadURL: await getDownloadURL(fileRef)
				}
			};
		}
	};
	const createMessage = async (chatId: ChatInfo['id'], type: Message['type'], content: Message['content']) => {
		try {
			const messageRef = doc(collection(doc(chatCol, chatId), 'messages'));
			if (type === 'media') {
				content = await uploadMedia(chatId, messageRef.id, content);
			} else if (type === 'file') {
				content = await uploadFile(chatId, messageRef.id, content);
			}
			await setDoc(messageRef, {
				id: messageRef.id,
				type,
				content,
				created_at: Timestamp.fromDate(new Date()),
				sender_id: await getUid()
			});
		} catch (e: unknown) {
			console.error(e);
			throw e instanceof FirebaseError ? e.code : e;
		}
	};
	const getMessageSenderInfo = async message => {
		try {
			const { sender_id, ...m } = message;
			const { displayName, photoURL } = (await getUserdataById(sender_id))?.info as UserInfo;
			return { ...m, sender: { id: sender_id, displayName, photoURL } };
		} catch (e: unknown) {
			console.error(e);
			throw e instanceof FirebaseError ? e.code : e;
		}
	};
	const getFullMessageInfo = async message => {
		try {
			const { sender_id, ...m } = message;
			const promises = [];
			promises.push(getUserdataById(sender_id));
			if (m.content.image && Object.keys(m.content.image).length) {
				promises.push(getBlob(storageRef(storage, m.content.image.fullpath)));
			}
			return (await Promise.all(promises)).reduce(
				(acc, res) => {
					if (res.info) {
						const { displayName, photoURL } = res.info;
						acc.sender = { id: sender_id, displayName, photoURL };
					} else {
						acc.content.image = {
							...m.content.image,
							blob: res
						};
					}
					return acc;
				},
				{ ...m }
			);
		} catch (e: unknown) {
			console.error(e);
			throw e instanceof FirebaseError ? e.code : e;
		}
	};
	const fetchChatMessages = async (chatId: ChatInfo['id'], lmt = 10) => {
		try {
			const messagesCol = collection(doc(chatCol, chatId), 'messages');
			const q = query(messagesCol, orderBy('created_at', 'desc'), limit(lmt));
			const unsubscribe = onSnapshot(q, async messagesRef => {
				const initialMessages = [];
				const promises = [] as Array<Promise<Message>>;

				messagesRef.docChanges().forEach(change => {
					if (change.type === 'added') {
						initialMessages.unshift({ ...change.doc.data(), created_at: change.doc.data().created_at.toDate() });
					}
				});
				initialMessages.forEach(m => {
					promises.push(getMessageSenderInfo(m));
				});
				(await Promise.all(promises)).forEach(m => {
					addMessage(m, 'end');
				});
				if (messagesRef.size >= lmt) {
					lastVisible.top = messagesRef.docs[messagesRef.docs.length - 1];
				}
			});
			return unsubscribe;
		} catch (e: unknown) {
			console.error(e);
			throw e instanceof FirebaseError ? e.code : e;
		}
	};
	const loadMoreChatMessages = async (chatId: ChatInfo['id'], direction = 'top', perPage = 10) => {
		try {
			if (lastVisible[direction]) {
				const messagesCol = collection(doc(chatCol, chatId), 'messages');
				const q = query(messagesCol, orderBy('created_at', direction === 'top' ? 'desc' : 'asc'), startAfter(lastVisible[direction]), limit(perPage));
				const messagesRef = await getDocs(q);
				if (messagesRef.empty) {
					lastVisible[direction] = null;
					return;
				}
				if (messages.value.length > 40) {
					deleteMessages(perPage, direction === 'top' ? 'end' : 'start');
					const msgBeforeDel = await getDoc(doc(messagesCol, messages.value[direction === 'top' ? messages.value.length - 1 : 0].id));
					lastVisible[direction === 'top' ? 'bottom' : 'top'] = msgBeforeDel;
				}
				const initialMessages = [];
				const promises = [] as Array<Promise<Message>>;
				messagesRef.forEach(doc => {
					initialMessages.push({ ...doc.data(), created_at: doc.data().created_at.toDate() });
				});
				initialMessages.forEach(m => {
					promises.push(getMessageSenderInfo(m));
				});
				(await Promise.all(promises)).forEach(m => {
					addMessage(m, direction === 'top' ? 'start' : 'end');
				});
				lastVisible[direction] = messagesRef.size >= perPage ? messagesRef.docs[messagesRef.docs.length - 1] : null;
			}
		} catch (e: unknown) {
			console.error(e);
			throw e instanceof FirebaseError ? e.code : e;
		}
	};
	return {
		messages,
		lastVisible,
		clearMessages,
		deleteMessages,
		createMessage,
		fetchChatMessages,
		loadMoreChatMessages
	};
});
